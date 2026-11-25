// A worker process. It claims jobs the scheduler marked "ready", runs them
// and reports the result. It takes no scheduling decision.
//
// Reliability rests on a lease. A claimed job belongs to this worker only
// while its heartbeats keep pushing lease_expires_at forward. If the process
// dies, the lease runs out and the scheduler hands the job to another worker.

import { hostname } from "node:os";
import { config } from "./config.ts";
import { connect, refusedByPostgres, sleep } from "./db.ts";

// In a container the hostname and the pid (always 1) survive a restart, so a
// worker that crashed comes back under the same id. See heartbeat().
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const db = connect(4);

interface ClaimedJob {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// The jobs this process is working on right now. Each one takes a slot, and
// every heartbeat extends its lease.
const running = new Set<ClaimedJob>();
// Finished jobs whose result Postgres has not taken yet.
let unsavedResults = 0;
let stopping = false;

// FOR UPDATE SKIP LOCKED lets many workers claim at the same time without
// waiting on each other, and never hands the same job to two of them.
//
// The attempt is counted here, when the job is taken, not when it ends. If
// the answer to this statement is lost (a timeout), the jobs are ours in
// Postgres but we do not know them. Nobody extends their lease, so the
// scheduler takes them back after one lease, with the attempt used.
//
// The jobs are picked first, once, and then updated. MATERIALIZED says so
// to Postgres. With the pick written inside "WHERE id IN (...)", Postgres
// may run it again for every row, each time skipping the rows it has just
// taken, and the claim takes more jobs than the worker has slots.
export const CLAIM_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM jobs
    WHERE status = 'ready'
    ORDER BY ready_at, id
    LIMIT $3
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs
  SET status = 'running',
      worker_id = $1,
      attempts = attempts + 1,
      started_at = now(),
      lease_expires_at = now() + $2::int * interval '1 ms'
  FROM picked
  WHERE jobs.id = picked.id
  RETURNING jobs.id, jobs.payload, jobs.attempts, jobs.max_attempts`;

async function claim(limit: number): Promise<ClaimedJob[]> {
  const { rows } = await db.query(CLAIM_SQL, [workerId, config.leaseMs, limit]);
  return rows;
}

// Tell the scheduler we are alive, and keep the lease on the jobs we are
// working on. Only those are extended, not every job stored under our id. A
// worker that restarts under the same id must not keep the jobs of its
// previous life alive: they expire and are retried.
async function heartbeat(): Promise<void> {
  const slots = stopping ? 0 : config.workerSlots;
  await db.query(
    `INSERT INTO workers (id, slots, last_seen) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET slots = EXCLUDED.slots, last_seen = now()`,
    [workerId, slots],
  );
  await db.query(
    `UPDATE jobs SET lease_expires_at = now() + $2::int * interval '1 ms'
     WHERE worker_id = $1 AND status = 'running' AND id = ANY($3::bigint[])`,
    [workerId, config.leaseMs, [...running].map((job) => job.id)],
  );
}

// The "work". This is the only code in the system that reads the payload.
//   sleep_ms       how long the job takes
//   fail_attempts  fail on purpose on the first N attempts (to test retries)
async function handle(job: ClaimedJob): Promise<void> {
  await sleep(Number(job.payload.sleep_ms ?? 0));
  if (job.attempts <= Number(job.payload.fail_attempts ?? 0)) {
    throw new Error(`simulated failure on attempt ${job.attempts}`);
  }
}

/** What happens to a job after an attempt, and when a retry may start. */
export function outcomeOf(
  attempts: number,
  maxAttempts: number,
  error: string | null,
): { status: "succeeded" | "failed" | "dead"; retryInMs: number } {
  if (error === null) return { status: "succeeded", retryInMs: 0 };
  if (attempts >= maxAttempts) return { status: "dead", retryInMs: 0 };
  // Exponential backoff: 2 s after the first failure, then 4 s, 8 s ...
  return {
    status: "failed",
    retryInMs: config.backoffMs * 2 ** (attempts - 1),
  };
}

// Record how the attempt ended and charge the tenant for the worker time it
// used, in one statement. The WHERE clause is a fence: if our lease expired
// and the job went to another worker, nothing matches and nothing changes.
async function report(job: ClaimedJob, error: string | null): Promise<void> {
  const { status, retryInMs } = outcomeOf(
    job.attempts,
    job.max_attempts,
    error,
  );
  const { rowCount } = await db.query(
    `WITH ended AS (
       UPDATE jobs
       SET status = $4,
           last_error = coalesce($5, last_error),
           run_at = CASE WHEN $4 = 'failed'
                         THEN now() + $6::int * interval '1 ms'
                         ELSE run_at END,
           finished_at = CASE WHEN $4 = 'failed' THEN NULL ELSE now() END,
           lease_expires_at = NULL
       WHERE id = $1 AND worker_id = $2 AND attempts = $3
         AND status = 'running'
       RETURNING tenant_id,
                 extract(epoch FROM now() - started_at)::float8 AS seconds
     )
     UPDATE tenants t
     SET vtime = t.vtime + ended.seconds / t.weight
     FROM ended
     WHERE t.id = ended.tenant_id`,
    [job.id, workerId, job.attempts, status, error, retryInMs],
  );
  if (rowCount === 0) {
    console.warn(`job ${job.id}: lease was lost, the result is ignored`);
  }
}

// Postgres can be away for a while. A finished job is not thrown away for
// that: the worker offers the result again every second until Postgres
// answers. Every answer ends the loop:
//   - the result is saved,
//   - the fence in report() says the job is no longer ours,
//   - Postgres refuses the statement itself, and would refuse it every time.
// The lease is not extended while we wait. A result that is not saved in time,
// or never, is not a lost job: the scheduler takes the job back and it runs
// again (delivery is at least once).
async function reportUntilAnswered(
  job: ClaimedJob,
  error: string | null,
): Promise<void> {
  for (let failures = 0; ; failures++) {
    try {
      return await report(job, error);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (refusedByPostgres(err)) {
        console.error(
          `job ${job.id}: result refused, the job is left to its lease:`,
          reason,
        );
        return;
      }
      if (failures === 0) {
        console.error(`job ${job.id}: result not saved yet, retrying:`, reason);
      }
      await sleep(1000);
    }
  }
}

// A worker that is asked to stop gives back the jobs it cannot finish in
// time. They return to the front of their queue at once and the attempt is
// not counted: being stopped is not a failure of the job. The tenant is still
// charged for the worker time it used.
async function handBack(jobs: ClaimedJob[]): Promise<void> {
  const { rows } = await db.query(
    `WITH returned AS (
       UPDATE jobs
       SET status = 'pending',
           attempts = attempts - 1,
           last_error = 'handed back: its worker was stopped',
           lease_expires_at = NULL
       WHERE worker_id = $1 AND status = 'running' AND id = ANY($2::bigint[])
       RETURNING tenant_id,
                 extract(epoch FROM now() - started_at)::float8 AS seconds
     ),
     used AS (
       SELECT tenant_id, sum(seconds) AS seconds
       FROM returned
       GROUP BY tenant_id
     ),
     charged AS (
       UPDATE tenants t
       SET vtime = t.vtime + used.seconds / t.weight
       FROM used
       WHERE t.id = used.tenant_id
     )
     SELECT count(*)::int AS jobs FROM returned`,
    [workerId, jobs.map((job) => job.id)],
  );
  // Fewer than we held, if the scheduler took some back in the meantime.
  console.log(
    `worker ${workerId}: handed back ${rows[0].jobs} unfinished jobs`,
  );
}

async function run(job: ClaimedJob): Promise<void> {
  let error: string | null = null;
  try {
    await handle(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // The work is over and the slot is free. What is left is to save the result.
  running.delete(job);
  unsavedResults += 1;
  await reportUntilAnswered(job, error);
  unsavedResults -= 1;
}

async function main(): Promise<void> {
  await heartbeat();
  const beat = setInterval(() => {
    heartbeat().catch((err) => console.error("heartbeat failed:", err.message));
  }, config.heartbeatMs);
  console.log(`worker ${workerId} started, ${config.workerSlots} slots`);

  while (!stopping) {
    let claimed = 0;
    const free = config.workerSlots - running.size;
    if (free > 0) {
      try {
        const jobs = await claim(free);
        claimed = jobs.length;
        for (const job of jobs) {
          running.add(job);
          void run(job);
        }
      } catch (err) {
        console.error("claim failed:", (err as Error).message);
        await sleep(1000);
      }
    }
    // Nothing was ready, or every slot is busy: look again shortly.
    if (claimed === 0) await sleep(config.pollMs);
  }

  // Shutdown. Take no new jobs, tell the scheduler our slots are gone, and
  // give running jobs a moment to finish and to save their result. Whatever
  // is still running after that goes back to the queue. If even that fails,
  // the lease recovers the jobs, like after a crash.
  await heartbeat().catch(() => {});
  const deadline = Date.now() + config.shutdownGraceMs;
  const busy = () => running.size > 0 || unsavedResults > 0;
  while (busy() && Date.now() < deadline) await sleep(50);
  if (running.size > 0) {
    await handBack([...running]).catch((err) =>
      console.error("hand back failed:", err.message),
    );
  }
  clearInterval(beat);
  await db
    .query("DELETE FROM workers WHERE id = $1", [workerId])
    .catch(() => {});
  await db.end();
  process.exit(0);
}

if (import.meta.main) {
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  await main();
}
