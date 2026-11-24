// A worker process. It claims jobs the scheduler marked "ready", runs them
// and reports the result. It takes no scheduling decision.
//
// Reliability rests on a lease. A claimed job belongs to this worker only
// while its heartbeats keep pushing lease_expires_at forward. If the process
// dies, the lease runs out and the scheduler hands the job to another worker.

import { hostname } from "node:os";
import { config } from "./config.ts";
import { connect, sleep } from "./db.ts";

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

// The jobs this process is running right now.
const running = new Set<ClaimedJob>();
let stopping = false;

// FOR UPDATE SKIP LOCKED lets many workers claim at the same time without
// waiting on each other, and never hands the same job to two of them.
async function claim(limit: number): Promise<ClaimedJob[]> {
  const { rows } = await db.query(
    `UPDATE jobs
     SET status = 'running',
         worker_id = $1,
         attempts = attempts + 1,
         started_at = now(),
         lease_expires_at = now() + $2::int * interval '1 ms'
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'ready'
       ORDER BY ready_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, payload, attempts, max_attempts`,
    [workerId, config.leaseMs, limit],
  );
  return rows;
}

// Tell the scheduler we are alive, and keep the lease on our running jobs.
// Only the jobs this process holds in memory are extended, not every job
// stored under our id. A worker that restarts under the same id must not
// keep the jobs of its previous life alive: they expire and are retried.
// The same goes for a job whose result could not be saved.
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

// Postgres can be away for a moment. Keep trying for a while. If we give up,
// the lease expires and the job runs again: delivery is at least once.
async function reportWithRetry(
  job: ClaimedJob,
  error: string | null,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await report(job, error);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(500 * attempt);
    }
  }
}

async function run(job: ClaimedJob): Promise<void> {
  let error: string | null = null;
  try {
    await handle(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    await reportWithRetry(job, error);
  } catch (err) {
    console.error(`job ${job.id}: result not saved, it will run again`, err);
  } finally {
    running.delete(job);
  }
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
  // give running jobs a moment to finish. Whatever is still running after
  // that is recovered through its lease, like a crash.
  await heartbeat().catch(() => {});
  const deadline = Date.now() + config.shutdownGraceMs;
  while (running.size > 0 && Date.now() < deadline) await sleep(50);
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
