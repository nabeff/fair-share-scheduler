// The scheduler. It runs one short pass every few milliseconds:
//
//   1. take back the jobs whose worker went silent (crash recovery)
//   2. count the slots of the workers that are alive
//   3. load one row per tenant: weight, usage, running and waiting jobs
//   4. let decide() choose who gets the free workers (src/fairshare.ts)
//   5. mark that many of their oldest waiting jobs "ready" for the workers
//
// It keeps no job and no tenant in memory between two passes. Everything it
// knows about them comes from Postgres, so it can crash and restart at any
// point without losing anything. It only looks at job status and timestamps,
// never at the content of a job, so it cannot know how long a job will take.

import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { connect, sleep, type Db } from "./db.ts";
import { decide, type Decision, type TenantSnapshot } from "./fairshare.ts";

// Any number works, two scheduler instances only have to agree on it.
export const SCHEDULER_LOCK = 7_316_001;

// Every query of a pass is written to read a few rows through an index.
// Postgres picks its plan from table statistics, and a queue changes too
// fast for them: it goes from empty to 100,000 rows and back between two
// ANALYZE runs. With wrong statistics it sometimes chose to read the whole
// backlog, and a pass got slower as the queue grew. Inside the scheduler's
// transaction only index scans are allowed, so the cost of a pass does not
// depend on the statistics. JIT compilation is off because it would add
// about 20 ms to a query that takes less than 1 ms.
const PLAN_SETTINGS = [
  "SET LOCAL enable_seqscan = off",
  "SET LOCAL enable_bitmapscan = off",
  "SET LOCAL jit = off",
].join("; ");

/**
 * One scheduler pass. Returns the snapshot it decided on, or null if skipped.
 * With judgeLeases false, step 1 is left out: see leaseGrace() for when.
 */
export async function pass(
  db: Db,
  judgeLeases = true,
): Promise<PassResult | null> {
  const tx = await db.connect();
  let failed = false;
  try {
    await tx.query(`BEGIN; ${PLAN_SETTINGS}`);

    // Only one scheduler decides at a time. A second instance finds the lock
    // taken and skips its pass, which makes it a hot standby.
    const lock = await tx.query(
      "SELECT pg_try_advisory_xact_lock($1) AS held",
      [SCHEDULER_LOCK],
    );
    if (!lock.rows[0].held) {
      await tx.query("ROLLBACK");
      return null;
    }

    if (judgeLeases) await reclaimExpiredLeases(tx);
    const totalSlots = await liveSlots(tx);
    const tenants = await loadTenants(tx, totalSlots);
    const decision = decide(tenants, totalSlots);
    await apply(tx, decision);

    await tx.query("COMMIT");
    return { totalSlots, tenants, decision };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // After a failure the connection is closed instead of reused: it may be
    // broken, or still waiting for an answer that never comes. Closing it
    // also rolls the transaction back and frees the lock.
    tx.release(failed);
  }
}

export interface PassResult {
  totalSlots: number;
  tenants: TenantSnapshot[];
  decision: Decision;
}

// Crash recovery. A running job whose lease ran out has lost its worker: the
// process died, hung, or was cut off from Postgres. The job goes back to the
// queue and keeps its place at the front. If it has used all its attempts it
// is buried instead, so a job that keeps killing its workers cannot loop
// forever. The tenant is charged for the time the job held a worker slot.
async function reclaimExpiredLeases(tx: PoolClient): Promise<void> {
  await tx.query(
    `WITH expired AS (
       UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts
                         THEN 'dead' ELSE 'pending' END,
           finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
           last_error = 'lease expired: the worker stopped sending heartbeats',
           lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < now()
       RETURNING tenant_id,
                 extract(epoch FROM now() - started_at)::float8 AS seconds
     ),
     used AS (
       SELECT tenant_id, sum(seconds) AS seconds
       FROM expired
       GROUP BY tenant_id
     )
     UPDATE tenants t
     SET vtime = t.vtime + used.seconds / t.weight
     FROM used
     WHERE t.id = used.tenant_id`,
  );
}

// Slots of the workers that sent a heartbeat recently. A worker that stays
// silent for a whole lease is considered gone.
async function liveSlots(tx: PoolClient): Promise<number> {
  const { rows } = await tx.query(
    `SELECT coalesce(sum(slots), 0)::int AS slots
     FROM workers
     WHERE last_seen > now() - $1::int * interval '1 ms'`,
    [config.leaseMs],
  );
  return rows[0].slots;
}

// One row per tenant. Every number comes from the head of a partial index,
// so the query costs the same with 10 waiting jobs or with 100,000.
async function loadTenants(
  tx: PoolClient,
  totalSlots: number,
): Promise<TenantSnapshot[]> {
  const { rows } = await tx.query(
    `SELECT t.id, t.weight, t.vtime, t.active,
            coalesce(held.running, 0)::int AS running,
            coalesce(held.running_seconds, 0)::float8 AS "runningSeconds",
            head.waiting::int AS waiting
     FROM tenants t
     -- Jobs that hold a worker slot, and for how long they have been running.
     LEFT JOIN (
       SELECT tenant_id,
              count(*) AS running,
              sum(greatest(extract(epoch FROM now() - started_at), 0))
                FILTER (WHERE status = 'running') AS running_seconds
       FROM jobs
       WHERE status IN ('ready', 'running')
       GROUP BY tenant_id
     ) held ON held.tenant_id = t.id
     -- Jobs waiting to be picked. We never dispatch more than the pool in
     -- one pass, so counting stops there instead of walking the backlog.
     -- The ORDER BY is the order of the jobs_waiting index: Postgres walks
     -- the index from its start and stops at the LIMIT.
     CROSS JOIN LATERAL (
       SELECT count(*) AS waiting
       FROM (
         SELECT 1 FROM jobs j
         WHERE j.tenant_id = t.id
           AND j.status IN ('pending', 'failed')
           AND j.run_at <= now()
         ORDER BY j.created_at, j.id
         LIMIT $1
       ) first_waiting
     ) head`,
    [Math.max(totalSlots, 1)],
  );
  return rows;
}

async function apply(tx: PoolClient, decision: Decision): Promise<void> {
  for (const [tenantId, vtime] of decision.activate) {
    await tx.query(
      `UPDATE tenants SET active = true, vtime = greatest(vtime, $2)
       WHERE id = $1`,
      [tenantId, vtime],
    );
  }
  if (decision.deactivate.length > 0) {
    await tx.query("UPDATE tenants SET active = false WHERE id = ANY($1)", [
      decision.deactivate,
    ]);
  }
  for (const [tenantId, count] of decision.dispatch) {
    // Oldest first within a tenant. A retried job keeps its creation time,
    // so it stays in front of the jobs submitted after it. While it waits
    // for its backoff ("failed", run_at in the future) it is skipped.
    await tx.query(
      `UPDATE jobs SET status = 'ready', ready_at = now()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE tenant_id = $1
           AND status IN ('pending', 'failed')
           AND run_at <= now()
         ORDER BY created_at, id
         LIMIT $2
       )`,
      [tenantId, count],
    );
  }
}

/**
 * A database outage is not a crash of every worker. If the scheduler could
 * not reach Postgres, the workers could not either: their leases ran out,
 * but nobody died. So once Postgres answers again, no job is taken back for
 * one lease. A worker that is alive extends its leases and saves its results
 * in that time, and only the jobs of workers that are really gone are left.
 * A scheduler that starts waits the same way: it does not know what happened
 * before it started.
 *
 * The price: crash recovery waits too. A worker that really died is noticed
 * one lease later, and not at all while passes keep failing.
 */
export function leaseGrace(leaseMs: number, now = () => performance.now()) {
  let endsAt = now() + leaseMs;
  return {
    /** True when leases may be judged again. */
    isOver: () => now() >= endsAt,
    /** Postgres did not answer: no end in sight until it does. */
    passFailed: () => void (endsAt = Infinity),
    /** Postgres answered. After a failure, the lease of grace starts here. */
    passWorked: () => {
      if (endsAt === Infinity) endsAt = now() + leaseMs;
    },
  };
}

/** One line showing who holds the workers right now, for the logs. */
function describe({ totalSlots, tenants }: PassResult): string {
  const busy = tenants
    .filter((t) => t.running > 0 || t.waiting > 0)
    .map((t) => `${t.id}=${t.running}${t.waiting > 0 ? "+" : ""}`);
  return `slots=${totalSlots} running: ${busy.join(" ") || "nothing"}`;
}

async function main(): Promise<void> {
  const db = connect(2);
  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  console.log(`scheduler started, one pass every ${config.tickMs} ms`);

  let lastLog = 0;
  let lastPicture = "";
  let passes = 0;
  let passMs = 0;
  const grace = leaseGrace(config.leaseMs);
  while (!stopping) {
    try {
      const startedAt = performance.now();
      const result = await pass(db, grace.isOver());
      grace.passWorked();
      passMs += performance.now() - startedAt;
      passes += 1;
      // Every few seconds, when the picture changed: who holds the workers,
      // and how long a pass takes on average.
      if (result && Date.now() - lastLog >= config.logEveryMs) {
        const picture = describe(result);
        if (picture !== lastPicture) {
          console.log(`${picture} (pass: ${(passMs / passes).toFixed(1)} ms)`);
        }
        lastPicture = picture;
        lastLog = Date.now();
        passes = 0;
        passMs = 0;
      }
      await sleep(config.tickMs);
    } catch (err) {
      console.error("scheduler pass failed:", (err as Error).message);
      grace.passFailed();
      await sleep(1000);
    }
  }
  await db.end();
}

if (import.meta.main) await main();
