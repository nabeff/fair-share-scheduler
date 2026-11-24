# Fair Share Task Scheduler

A job scheduler for a platform with many tenants. All tenants share one pool of workers. Each tenant with work waiting gets a share of worker time in proportion to its weight, so one tenant can queue 100,000 jobs without making the others wait.

TypeScript on Node 24, and Postgres as the only storage and as the queue. The scheduling logic is written by hand in [`src/fairshare.ts`](src/fairshare.ts).

The design, the guarantees and the limits are in [DESIGN.md](DESIGN.md).

## Run it

```bash
docker compose up --build
```

| Service      | What it does                                                          |
| ------------ | --------------------------------------------------------------------- |
| `db`         | Postgres 17                                                           |
| `migrate`    | creates the tables, seeds the tenants from `tenants.json`, then exits |
| `api`        | HTTP API on port 8080                                                 |
| `scheduler`  | decides which tenant runs next                                        |
| `worker` x 4 | four separate processes, 5 jobs at once each: a pool of 20            |

Submit a job, then read its status:

```bash
curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' \
  -d '{"tenant_id": "small-1", "payload": {"sleep_ms": 200}}'
# {"id":"1","status":"pending"}

curl -s localhost:8080/jobs/1
# {"id":"1","tenant_id":"small-1","status":"succeeded","attempts":1,"max_attempts":3,
#  "created_at":"...","started_at":"...","finished_at":"...","run_at":"...","last_error":null}
```

- Tenants and weights come from `tenants.json`: `big` and `small-1` to `small-4` (weight 1), `bronze` (1), `silver` (2), `gold` (4).
- The worker simulates work from the payload: `sleep_ms` is how long the job takes, `fail_attempts` makes it fail on its first N attempts. The scheduler never reads the payload.
- More workers: `docker compose up -d --scale worker=8`. The scheduler sees the new pool size by itself.
- After a code change: `docker compose up -d --build`.

## How it works

```
client -- POST /jobs --> API -- insert as "pending" ---+
                                                       v
scheduler -- "pending" to "ready", by fair share --> Postgres   (the jobs table is the queue)
                                                       ^
workers -- claim "ready", run, save the result --------+
```

1. The **API** stores the job as `pending`.
2. Every 20 ms the **scheduler** runs one short transaction:
   - it takes back the jobs whose worker went silent,
   - it counts the slots of the workers that are alive,
   - it loads one row per tenant: weight, worker time used, running and waiting jobs,
   - it gives each free slot to the tenant with waiting jobs that has used the least worker time for its weight,
   - it marks that tenant's oldest waiting job `ready`.
3. A **worker** claims `ready` jobs with `FOR UPDATE SKIP LOCKED`, runs them, and extends their lease with a heartbeat every 2 seconds.
4. When a job ends, one SQL statement saves the result and adds the time it used to the tenant's usage.

Job states:

| State       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `pending`   | waiting for the scheduler                                                       |
| `ready`     | picked by the scheduler, waiting for a worker (the API reports it as `pending`) |
| `running`   | a worker holds it under a lease                                                 |
| `succeeded` | done                                                                            |
| `failed`    | the attempt threw an error, a retry starts after 2 s, then 4 s                  |
| `dead`      | failed or crashed 3 times, kept with its last error                             |

Where things are:

| File                  | Role                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `src/fairshare.ts`    | the scheduling decision: a pure function, no database. Start here.              |
| `src/scheduler.ts`    | the loop around it: reads Postgres, applies the decision, recovers crashed jobs |
| `src/worker.ts`       | claim, run, heartbeat, report                                                   |
| `src/api.ts`          | `POST /jobs` and `GET /jobs/:id`                                                |
| `db/schema.sql`       | three tables: `tenants`, `jobs`, `workers`                                      |
| `scripts/loadtest.ts` | the load test                                                                   |
| `test/`               | unit tests, a simulation of the pool, crash tests with real processes           |

## Tests

```bash
docker compose run --rm test
```

36 tests:

- `fairshare.test.ts`: the "pick the next tenant" logic. Weights, the cap, the idle rule, a tenant alone.
- `simulation.test.ts`: the same function driving a simulated pool. A flood, weights 1, 2, 4, 5 minute jobs, 60 tenants.
- `recovery.test.ts`: a real scheduler and real workers on a real Postgres. A worker is killed with SIGKILL in the middle of a job and the job is retried. A job that fails once succeeds on the retry. A job that always fails is `dead` after 3 attempts.
- `worker.test.ts` and `scheduler.test.ts`: the retry backoff, and a check that the scheduling code never mentions the payload.

Without Docker: `npm install && npm test`, with Node 24 or newer. The database tests use the Postgres of `docker compose up -d db` on port 54329, and are skipped when it is not reachable.

## Load test

```bash
docker compose run --rm loadtest           # both scenarios, about 2 minutes
docker compose run --rm loadtest flood     # only the first
docker compose run --rm loadtest weights   # only the second
```

The script submits jobs through the HTTP API and measures from the job timestamps in Postgres. It prints a report and writes it to `results/` as text and CSV. **It empties the job table before and after.**

The numbers below come from a real run on a laptop (Docker VM with 6 CPUs, pool of 20 worker slots). The files of that run are in [`results/`](results).

### Scenario 1: one tenant floods

`big` submits 100,000 jobs of 50 to 500 ms through the API (12,885 jobs per second). Then four small tenants submit 5, 7, 8 and 10 jobs. At that moment 99,280 jobs of `big` are still waiting.

```
 tenant  jobs  wait p50  wait p95  wait max  all jobs done after
-------  ----  --------  --------  --------  -------------------
small-1     5    191 ms    265 ms    273 ms               587 ms
small-2     7    207 ms    361 ms    425 ms               701 ms
small-3     8    282 ms    316 ms    316 ms               623 ms
small-4    10    370 ms    467 ms    467 ms               727 ms
```

Every job of a small tenant started within 467 ms. In one first in, first out queue they would have waited about 23 minutes.

The wait is not 0 because there is no preemption: when the small tenants arrive every worker is busy with a job of `big`, and they wait for those jobs to finish.

Who held the workers, per 5 second bucket (time 0 is when the small tenants submit):

```
time   big  small-1  small-2  small-3  small-4                          pool of 20 workers
----  ----  -------  -------  -------  -------  ------------------------------------------
-10s  18.4      0.0      0.0      0.0      0.0  |#####################################...|
 -5s  18.3      0.0      0.0      0.0      0.0  |#####################################...|
 +0s  16.8      0.3      0.4      0.3      0.4  |##################################23....|
 +5s  18.3      0.0      0.0      0.0      0.0  |#####################################...|
+10s  18.3      0.0      0.0      0.0      0.0  |#####################################...|
(average workers held per tenant. # = big, 1 = small-1, 2 = small-2, 3 = small-3, 4 = small-4, . = idle)
```

The same, zoomed in on the arrival (250 ms buckets):

```
  time   big  small-1  small-2  small-3  small-4                          pool of 20 workers
------  ----  -------  -------  -------  -------  ------------------------------------------
-0.50s  19.0      0.0      0.0      0.0      0.0  |######################################..|
-0.25s  17.6      0.0      0.0      0.0      0.0  |###################################.....|
+0.00s  11.8      1.4      1.6      1.9      2.1  |########################1122223334444...|
+0.25s   3.4      3.7      4.3      3.8      3.0  |#######11111112222222223333333444444....|
+0.50s  11.6      0.7      1.3      1.0      3.2  |#######################1122334444444....|
+0.75s  18.1      0.0      0.0      0.0      0.0  |####################################....|
+1.00s  18.3      0.0      0.0      0.0      0.0  |#####################################...|
+1.25s  18.2      0.0      0.0      0.0      0.0  |####################################....|
+1.50s  18.2      0.0      0.0      0.0      0.0  |####################################....|
+1.75s  17.9      0.0      0.0      0.0      0.0  |####################################....|
+2.00s  18.3      0.0      0.0      0.0      0.0  |#####################################...|
+2.25s  18.4      0.0      0.0      0.0      0.0  |#####################################...|
(average workers held per tenant. # = big, 1 = small-1, 2 = small-2, 3 = small-3, 4 = small-4, . = idle)
```

What it shows:

- While it is alone, every worker goes to `big`.
- When the others arrive, `big` falls from 18 workers to about its fair share (4 of 20, there are 5 tenants) within 250 ms, and no job is stopped for it.
- When the small tenants are done, `big` gets the whole pool back.

About 1.7 of the 20 workers show as idle (the dots). Each job start waits for the next scheduler pass and the next worker poll, 20 ms each, and these jobs are short. [DESIGN.md](DESIGN.md) section 4 says how to remove that.

### Scenario 2: weights 1, 2 and 4

`bronze` (weight 1), `silver` (2) and `gold` (4) each keep a deep backlog for 60 seconds. Their jobs have very different lengths on purpose: 50 to 150 ms, 200 to 800 ms, and 1 to 3 s.

```
tenant  weight  jobs done  worker seconds  share  target
------  ------  ---------  --------------  -----  ------
bronze       1       1601           161.4  14.3%   14.3%
silver       2        637           323.1  28.5%   28.6%
  gold       4        326           647.9  57.2%   57.1%
```

Worker time follows the weights to within 0.1 point, although `bronze` ran about 5 times more jobs than `gold`. The split holds in every 5 second bucket:

```
time  bronze  silver  gold                          pool of 20 workers
----  ------  ------  ----  ------------------------------------------
 +0s     2.7     5.4  10.7  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
 +5s     2.6     5.3  10.9  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+10s     2.7     5.4  10.8  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+15s     2.7     5.4  10.7  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+20s     2.6     5.4  10.9  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+25s     2.7     5.4  10.7  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+30s     2.7     5.3  10.9  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+35s     2.7     5.5  10.6  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+40s     2.7     5.4  10.8  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+45s     2.7     5.4  10.8  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+50s     2.7     5.2  11.0  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
+55s     2.7     5.5  10.7  |bbbbbsssssssssssGGGGGGGGGGGGGGGGGGGGGG..|
(average workers held per tenant. b = bronze, s = silver, G = gold, . = idle)
```

### The scheduler keeps up

With 100,000 jobs queued a scheduler pass takes 2 to 3 ms, the same as with an empty queue. The scheduler prints it: `docker compose logs scheduler`.

## See a crash recovery

```bash
# 40 jobs of 20 seconds: each of the 4 workers takes 5
for i in $(seq 40); do
  curl -s -o /dev/null -X POST localhost:8080/jobs -H 'content-type: application/json' \
    -d '{"tenant_id": "big", "payload": {"sleep_ms": 20000}}'
done

# kill one worker without warning
docker kill $(docker compose ps -q worker | head -1)

# run this a few times
docker compose exec db psql -U postgres -d scheduler \
  -c "SELECT status, attempts, count(*) FROM jobs GROUP BY 1, 2 ORDER BY 1, 2"

# bring the worker back
docker compose up -d
```

About 10 seconds after the kill (the lease time) the 5 jobs of the dead worker are `pending` again. They are first in line, they start again with `attempts = 2`, and all 40 jobs end as `succeeded`.

## Settings

Environment variables and their defaults. In Docker, set them under `x-app` in `docker-compose.yml`.

| Variable       | Default | Meaning                                                          |
| -------------- | ------- | ---------------------------------------------------------------- |
| `WORKER_SLOTS` | 5       | jobs one worker process runs at once                             |
| `TICK_MS`      | 20      | pause between two scheduler passes                               |
| `POLL_MS`      | 20      | how often a free worker looks for a job                          |
| `HEARTBEAT_MS` | 2000    | how often a worker extends its leases                            |
| `LEASE_MS`     | 10000   | a job goes back to the queue when its worker is silent this long |
| `MAX_ATTEMPTS` | 3       | attempts before a job is `dead`                                  |
| `BACKOFF_MS`   | 2000    | wait before the first retry, doubled for the next one            |
| `API_PORT`     | 8080    | port of the API on the host                                      |
| `DB_PORT`      | 54329   | port of Postgres on the host                                     |
