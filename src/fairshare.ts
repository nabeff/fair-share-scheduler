// Fair share logic. Pure functions, no database.
//
// Virtual time (vtime) = worker seconds used / weight. The tenant with the
// lowest vtime goes next, so worker time follows the weights.

/** What the scheduler knows about one tenant at the start of a pass. */
export interface TenantSnapshot {
  id: string;
  weight: number;
  /** Finished attempts only, running jobs are added on top. */
  vtime: number;
  /** Had work at the previous pass. */
  active: boolean;
  /** Ready or running. */
  running: number;
  runningSeconds: number;
  waiting: number;
}

export interface Decision {
  /** Jobs to start now, per tenant. */
  dispatch: Map<string, number>;
  /** Tenants that just got work, with their starting vtime. */
  activate: Map<string, number>;
  deactivate: string[];
}

/**
 * Extra workers allowed above the fair share. Without it, tenants with very
 * short jobs fell below their share (12.4% instead of 14.3% in simulation).
 */
export const CAP_SLACK = 1;

/** Max workers a tenant may hold while others are waiting. */
export function cap(pool: number, weight: number, totalWeight: number): number {
  return Math.ceil((pool * weight) / totalWeight) + CAP_SLACK;
}

/** One pass: which tenants start or stop, and how many jobs each may start. */
export function decide(
  tenants: TenantSnapshot[],
  totalSlots: number,
): Decision {
  const hasWork = (t: TenantSnapshot) => t.waiting > 0 || t.running > 0;
  // Count running jobs too, or a 5 minute job looks free until it ends.
  const usage = (t: TenantSnapshot, vtime = t.vtime) =>
    vtime + t.runningSeconds / t.weight;

  // A tenant coming back from idle gets no credit for the time away.
  const stillActive = tenants.filter((t) => t.active && hasWork(t));
  const floor =
    stillActive.length > 0
      ? Math.min(...stillActive.map((t) => usage(t)))
      : Math.max(0, ...tenants.map((t) => t.vtime));

  const activate = new Map<string, number>();
  for (const t of tenants) {
    if (!t.active && hasWork(t)) activate.set(t.id, Math.max(t.vtime, floor));
  }
  const deactivate = tenants
    .filter((t) => t.active && !hasWork(t))
    .map((t) => t.id);

  const contenders: Contender[] = tenants.map((t) => ({
    id: t.id,
    weight: t.weight,
    running: t.running,
    waiting: t.waiting,
    usage: usage(t, activate.get(t.id)),
  }));
  const dispatch = dispatchFreeSlots(contenders, totalSlots);

  return { dispatch, activate, deactivate };
}

interface Contender {
  id: string;
  weight: number;
  running: number;
  waiting: number;
  usage: number;
}

// Give free workers out one at a time, each to the next tenant in line.
function dispatchFreeSlots(
  tenants: Contender[],
  totalSlots: number,
): Map<string, number> {
  const dispatch = new Map<string, number>();
  let free = totalSlots - sum(tenants, (t) => t.running);

  while (free > 0) {
    const waiting = tenants.filter((t) => t.waiting > 0);
    if (waiting.length === 0) break;

    // Only waiting tenants split the pool. Others keep what they hold.
    const settled = tenants.filter((t) => t.waiting === 0);
    const pool = totalSlots - sum(settled, (t) => t.running);
    const totalWeight = sum(waiting, (t) => t.weight);

    const next = pickNext(waiting, pool, totalWeight);
    // Can't happen: the caps add up to more than the pool.
    if (!next) break;

    next.running += 1;
    next.waiting -= 1;
    free -= 1;
    dispatch.set(next.id, (dispatch.get(next.id) ?? 0) + 1);
  }
  return dispatch;
}

/** Lowest usage among tenants under their cap. */
function pickNext(
  waiting: Contender[],
  pool: number,
  totalWeight: number,
): Contender | undefined {
  let best: Contender | undefined;
  for (const t of waiting) {
    if (t.running >= cap(pool, t.weight, totalWeight)) continue;
    if (!best || comesBefore(t, best)) best = t;
  }
  return best;
}

// True if a should get the next worker before b.
function comesBefore(a: Contender, b: Contender): boolean {
  if (a.usage !== b.usage) return a.usage < b.usage;
  // Tie: fewer running jobs per weight goes first, so they take turns.
  const loadA = a.running / a.weight;
  const loadB = b.running / b.weight;
  if (loadA !== loadB) return loadA < loadB;
  return a.id < b.id;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += value(item);
  return total;
}
