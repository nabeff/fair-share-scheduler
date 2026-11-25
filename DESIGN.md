# Design

Postgres is the only storage and also the queue. An **API** stores jobs, one **scheduler** decides which tenant runs next, **workers** run the jobs. States: `pending -> ready -> running -> succeeded`, or `failed` (retry planned), then `dead`.

## 1. What "fair" means, and how it is measured

**Definition.** While several tenants have work waiting, each gets worker time in proportion to its weight. A tenant alone uses every worker. The unit is worker seconds, not job count: jobs last 50 ms to 5 minutes and the scheduler cannot know which, so a job count would favour long jobs.

**How.** Each tenant has a virtual time: worker seconds used, divided by weight, running jobs included. A free worker goes to the tenant with waiting jobs and the lowest virtual time (`src/fairshare.ts`, a pure function). Two rules complete it:

- _Idle rule._ A tenant that returns after a pause restarts from the lowest virtual time among active tenants. Time away earns no credit, so it cannot take over the pool.
- _Cap._ A tenant holds at most `ceil(pool x weight / total weight of waiting tenants) + 1` workers. In a simulation without it, two equal tenants with 5 minute jobs swing between 6/94 and 89/11. With it: 45/55. It never idles a worker while a job waits.

**Measured** by `scripts/loadtest.ts` from job timestamps, on 20 worker slots:

1. Share of worker seconds per tenant per 5 s bucket, against weight / total weight. Weights 1, 2, 4 got 14.3%, 28.5%, 57.2% (target 14.3, 28.6, 57.1), job lengths 20x apart.
2. Wait from submit to start. Behind 99,280 queued jobs of one tenant, four small tenants started every job within 467 ms. One shared queue would have cost them 23 minutes.

**Limits.** No preemption: a newcomer waits for running jobs to finish. That is the 467 ms above, or 5 minutes if the pool is full of long jobs. The tenant that held the pool is charged for it and then waits until the others have caught up. In simulations: about 1 s with short jobs, 30 minutes with 5 minute jobs and weights 1, 2, 4. Shares over the whole period match the weights.

## 2. Guarantees

- **Not lost.** The API answers 201 only after the job is committed in Postgres. Every later step is one SQL transaction, and no process keeps a job only in memory.
- **At least once.** A job runs again if its worker dies before saving the result, or if its lease expires while it still runs (long pause, network cut). Jobs must be idempotent. A late result from a worker that lost its lease is refused: the write checks worker and attempt number.
- **Bounded retries.** 3 attempts with 2 s then 4 s of backoff, then the job is `dead` and kept with its last error. An attempt counts from the moment a worker takes the job: a crash counts, and so does a claim whose answer is lost. A job that kills its worker cannot loop.
- **Delay and order.** A job of a tenant below its share starts when a worker frees up, plus up to 45 ms of polling. After a worker crash its jobs restart within 10 s. Per tenant, oldest first.

**Not guaranteed:** exactly once, for runs or for submissions (a retry after a 503 can create the job twice); a maximum wait; a limit on job duration (a hung job keeps its slot while its worker lives); order across tenants; memory of usage before an idle period.

## 3. Failures

- **A worker crashes or hangs.** Heartbeats stop, the lease expires after 10 s and the scheduler requeues its jobs at the front. Tested with a real kill. A worker that is stopped (deploy, scale down) gets 8 s to finish, then hands the rest back with no attempt used.
- **The scheduler crashes.** It holds no job state. Running jobs finish, the API keeps accepting, nothing new starts until it returns. Two can run: an advisory lock picks one. One that freezes in the middle of a pass loses the lock after 5 s.
- **The API crashes.** Submissions fail and clients retry. Queued and running jobs carry on.
- **Postgres is down or silent.** No call waits longer than 5 s: the API answers 503, scheduler and workers retry. Workers keep finished results until Postgres takes them, and after an outage the scheduler waits one lease before it judges leases, so live workers keep their jobs. With 150 jobs queued and Postgres stopped for 12 or 30 s, frozen for 12 s, or restarted, no job was lost or ran twice. It is the single point of failure.
- **One tenant floods.** It fills only its own queue. The scheduler reads queue heads: a pass takes 2 to 3 ms with 10 or 100,000 jobs queued. Storage is unprotected: no queue limit.

## 4. At 5,000 tenants, 2,000 submissions/s, 500 workers

Submissions already fit: one API process stored 12,900 jobs/s on a laptop. To change:

1. **Tenant scan.** The scheduler reads every tenant on every pass. Keep active tenants in memory instead, in a heap ordered by virtual time, with Postgres as the source of truth.
2. **Polling.** Scheduler and workers poll every 20 ms: 500 idle workers would send 25,000 queries/s. LISTEN/NOTIFY with a slow fallback poll fixes that and removes the dispatch delay (8% of the pool idle with 275 ms jobs).
3. **Hot rows.** Every finished job updates its tenant's row. Batch usage per worker instead.
4. **Churn, connections.** A partitioned history table for finished jobs. PgBouncer.

**Next:** headroom or preemption for newcomers; a bound on catch-up; queue and rate limits per tenant; idempotency keys; job timeouts; metrics; requeue of dead jobs; authentication.

## 5. What I chose not to do

- **No queue product, no Redis.** One Postgres gives durable jobs, atomic state changes and the queue (`FOR UPDATE SKIP LOCKED`). All scheduling logic is in this repo.
- **No fixed quota or pool per tenant.** It wastes idle workers.
- **No round robin by job count.** Wrong unit when job lengths differ by 6,000x.
- **No preemption.** It wastes work and needs interruptible jobs. The cap covers most of it.
- **No distributed scheduling.** One decision maker at a time is easy to reason about.

## 6. Assumptions

- Tenants and weights are set in `tenants.json`. An unknown tenant gets 404.
- A "share of the workers" is a share of worker time. Any worker can run any job.
- Every timestamp is the Postgres clock, so drift between machines does not matter.
- No authentication, one region, one Postgres. Everything used is on the allowed list.
- No front end is asked for. `web/` is an extra: one more client of the API.
