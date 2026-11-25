// The scheduler. Each pass: take back jobs of dead workers, count free
// slots, let decide() pick tenants, mark their oldest jobs "ready".
// All state lives in Postgres, so it can restart at any time.

import type { PoolClient } from "pg";
import { config } from "./config.ts";
import { connect, sleep, type Db } from "./db.ts";
import { decide, type Decision, type TenantSnapshot } from "./fairshare.ts";

export const SCHEDULER_LOCK = 7_316_001;

// The queue size changes faster than Postgres statistics, and bad stats
// once made it scan the whole backlog. Force index scans so a pass stays
// fast. JIT would add ~20 ms to sub-millisecond queries.
const PLAN_SETTINGS = [
  "SET LOCAL enable_seqscan = off",
  "SET LOCAL enable_bitmapscan = off",
  "SET LOCAL jit = off",
].join("; ");

/** Returns null when another scheduler holds the lock. */
export async function pass(
  db: Db,
  judgeLeases = true,
): Promise<PassResult | null> {
  const tx = await db.connect();
  let failed = false;
  try {
    await tx.query(`BEGIN; ${PLAN_SETTINGS}`);

    // One scheduler at a time. A second one just skips (hot standby).
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
    // On failure, drop the connection instead of reusing it. This also
    // rolls back and frees the lock.
    tx.release(failed);
  }
}

export interface PassResult {
  totalSlots: number;
  tenants: TenantSnapshot[];
  decision: Decision;
}

// Crash recovery: a running job with an expired lease lost its worker.
// It goes back to the queue, or becomes dead after its last attempt.
// The tenant still pays for the time the job held the slot.
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

// Workers silent for a whole lease are considered gone.
async function liveSlots(tx: PoolClient): Promise<number> {
  const { rows } = await tx.query(
    `SELECT coalesce(sum(slots), 0)::int AS slots
     FROM workers
     WHERE last_seen > now() - $1::int * interval '1 ms'`,
    [config.leaseMs],
  );
  return rows[0].slots;
}

// Reads only the head of an index, so 10 or 100,000 waiting jobs cost the same.
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
     LEFT JOIN (
       SELECT tenant_id,
              count(*) AS running,
              sum(greatest(extract(epoch FROM now() - started_at), 0))
                FILTER (WHERE status = 'running') AS running_seconds
       FROM jobs
       WHERE status IN ('ready', 'running')
       GROUP BY tenant_id
     ) held ON held.tenant_id = t.id
     -- Count up to the pool size only, we never dispatch more per pass.
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

// Write the decision: tenant states, then mark the chosen jobs ready.
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
    // Oldest first. A retried job keeps its place; run_at skips it during backoff.
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
 * After a database outage every lease looks expired, but the workers are
 * fine. So wait one lease before taking jobs back, giving live workers time
 * to renew. Same on startup. Cost: a real crash is noticed a lease later.
 */
export function leaseGrace(leaseMs: number, now = () => performance.now()) {
  let endsAt = now() + leaseMs;
  return {
    isOver: () => now() >= endsAt,
    passFailed: () => void (endsAt = Infinity),
    passWorked: () => {
      if (endsAt === Infinity) endsAt = now() + leaseMs;
    },
  };
}

/** Log line: who holds the workers right now. */
function describe({ totalSlots, tenants }: PassResult): string {
  const busy = tenants
    .filter((t) => t.running > 0 || t.waiting > 0)
    .map((t) => `${t.id}=${t.running}${t.waiting > 0 ? "+" : ""}`);
  return `slots=${totalSlots} running: ${busy.join(" ") || "nothing"}`;
}

// Run a pass every TICK_MS until stopped.
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
      // Log every few seconds, only if something changed.
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
