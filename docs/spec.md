# Spec

What the system must do, how it does it, and how to check it. Tests run with `docker compose run --rm test`.

## 1. Submit a job and read its status

- **How:** `POST /jobs` stores a job (tenant and payload) as `pending` and returns its id. `GET /jobs/:id` returns its status. An unknown tenant or job gets 404, a bad request 400, and 503 while Postgres is away.
- **Check:** [`test/api.test.ts`](../test/api.test.ts).

## 2. A scheduler and workers in separate processes

- **How:** one scheduler and 4 worker processes with 5 slots each. Workers claim ready jobs with `FOR UPDATE SKIP LOCKED`, so two workers never take the same job.
- **Check:** [`test/claim.test.ts`](../test/claim.test.ts). The crash tests in [`test/recovery.test.ts`](../test/recovery.test.ts) start a real scheduler and real workers.

## 3. Fair sharing by weight

- **How:** each tenant's worker seconds are divided by its weight, and the lowest goes next. A tenant alone may use every worker. A tenant back from idle starts level with the others, with no saved credit.
- **Check:** [`test/fairshare.test.ts`](../test/fairshare.test.ts), [`test/simulation.test.ts`](../test/simulation.test.ts). In the load test, weights 1, 2 and 4 got 14.3%, 28.6% and 57.1% of the worker time ([`results/weights.txt`](../results/weights.txt)).

## 4. Job length is unknown

- **How:** the scheduler never reads the payload. It charges the time a job really held a worker, running jobs included, so a tenant with long jobs gets fewer of them.
- **Check:** "the scheduling code never touches the payload" in [`test/scheduler.test.ts`](../test/scheduler.test.ts), and "a tenant with only 5 minute jobs cannot take every worker" in [`test/simulation.test.ts`](../test/simulation.test.ts).

## 5. No job lost when a worker crashes

- **How:** a worker holds a job through a 10 s lease, renewed by a heartbeat every 2 s. When the lease runs out, the scheduler puts the job back. A late result from the old worker is ignored.
- **Check:** "a job is retried when its worker is killed in the middle" and "a result that arrives after the lease was lost is refused" in [`test/recovery.test.ts`](../test/recovery.test.ts). By hand: "See a crash recovery" in the [README](../README.md).

## 6. Limited retries

- **How:** 3 attempts, with a backoff of 2 s, then 4 s. After that the job is `dead`.
- **Check:** [`test/worker.test.ts`](../test/worker.test.ts), and "a job that always fails is dead after 3 attempts" in [`test/recovery.test.ts`](../test/recovery.test.ts).

## 7. Our own parts failing

- **How:** every database call has a timeout. When Postgres is down or frozen, the API answers 503 and the scheduler and workers retry until it is back. A scheduler that freezes loses its lock to the next pass.
- **Check:** "when Postgres is away for everyone" and "a scheduler that froze in the middle of a pass" in [`test/recovery.test.ts`](../test/recovery.test.ts).

## 8. A load script that shows fairness

- **How:** [`scripts/loadtest.ts`](../scripts/loadtest.ts) floods one tenant with 100,000 jobs, then 4 small tenants submit 5 to 10 jobs each. It records their waits and the share of each tenant every 5 seconds.
- **Check:** `docker compose run --rm loadtest`. Last run: every small job started within 542 ms ([`results/flood.txt`](../results/flood.txt)), shares over time in [`results/flood-shares.csv`](../results/flood-shares.csv).

## 9. Runs with one command, no fair share product

- **How:** `docker compose up` starts everything. Postgres is the storage and the queue. The fair share logic is our own, in [`src/fairshare.ts`](../src/fairshare.ts).
- **Check:** the [README](../README.md). Design, guarantees and assumptions are in [design.md](design.md).
