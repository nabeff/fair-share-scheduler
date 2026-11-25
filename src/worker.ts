// Worker: claims "ready" jobs, runs them, reports the result.
// A claimed job is ours only while our heartbeats renew its lease.

import { hostname } from "node:os";
import { config } from "./config.ts";
import { connect, refusedByPostgres, sleep } from "./db.ts";

// In Docker this id survives a restart. See heartbeat().
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const db = connect(4);

interface ClaimedJob {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

const running = new Set<ClaimedJob>();
// Results not saved yet.
let unsavedResults = 0;
let stopping = false;

// SKIP LOCKED: workers claim in parallel, never the same job twice.
// The attempt counts at claim time, so a lost reply still uses it.
// MATERIALIZED: pick once. Inside "WHERE id IN (...)" Postgres could run
// the pick per row and claim more jobs than we have slots.
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

// Take up to `limit` ready jobs.
async function claim(limit: number): Promise<ClaimedJob[]> {
  const { rows } = await db.query(CLAIM_SQL, [workerId, config.leaseMs, limit]);
  return rows;
}

// Renew only the jobs we really run. After a restart under the same id,
// jobs from before the crash must expire and be retried.
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

// The fake work, and the only place that reads the payload.
// fail_attempts makes the first N attempts fail, to test retries.
async function handle(job: ClaimedJob): Promise<void> {
  await sleep(Number(job.payload.sleep_ms ?? 0));
  if (job.attempts <= Number(job.payload.fail_attempts ?? 0)) {
    throw new Error(`simulated failure on attempt ${job.attempts}`);
  }
}

/** After an attempt: succeeded, failed (retry later) or dead. */
export function outcomeOf(
  attempts: number,
  maxAttempts: number,
  error: string | null,
): { status: "succeeded" | "failed" | "dead"; retryInMs: number } {
  if (error === null) return { status: "succeeded", retryInMs: 0 };
  if (attempts >= maxAttempts) return { status: "dead", retryInMs: 0 };
  // Backoff: 2 s, 4 s, 8 s ...
  return {
    status: "failed",
    retryInMs: config.backoffMs * 2 ** (attempts - 1),
  };
}

// Save the result and charge the tenant in one statement. The WHERE is a
// fence: if we lost the lease, nothing matches.
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

// If Postgres is down, keep retrying the result every second. If the lease
// runs out meanwhile, the job just runs again (at least once).
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

// On shutdown, give unfinished jobs back right away. Being stopped isn't
// the job's fault, so the attempt is refunded. The tenant still pays.
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
  console.log(
    `worker ${workerId}: handed back ${rows[0].jobs} unfinished jobs`,
  );
}

// Run one job, then save its result.
async function run(job: ClaimedJob): Promise<void> {
  let error: string | null = null;
  try {
    await handle(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  running.delete(job);
  unsavedResults += 1;
  await reportUntilAnswered(job, error);
  unsavedResults -= 1;
}

// Claim jobs while there are free slots, until stopped.
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
    if (claimed === 0) await sleep(config.pollMs);
  }

  // Shutdown: report 0 slots, let running jobs finish for a moment, then
  // hand back the rest. If that fails too, the leases cover it.
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
