// The fair share algorithm. Pure functions only: no database, no clock.
// The scheduler loads a snapshot, calls decide() and applies the result.
//
// Fairness is measured in worker time, not in job count, because nobody
// knows how long a job takes before it runs. Each tenant has a virtual time:
// the worker seconds it has used, divided by its weight. Serving the lowest
// virtual time first gives every tenant with waiting work a share of worker
// time in proportion to its weight.

/** What the scheduler knows about one tenant at the start of a pass. */
export interface TenantSnapshot {
  id: string;
  weight: number;
  /** Stored virtual time. Covers finished attempts only. */
  vtime: number;
  /** True if the tenant already had work at the previous pass. */
  active: boolean;
  /** Jobs that hold a worker slot: picked by us, or running. */
  running: number;
  /** Seconds the running jobs have run so far, summed over the jobs. */
  runningSeconds: number;
  /** Jobs waiting to be picked. */
  waiting: number;
}

export interface Decision {
  /** How many waiting jobs to hand to workers now, per tenant. */
  dispatch: Map<string, number>;
  /** Tenants that just got work, with the virtual time they start from. */
  activate: Map<string, number>;
  /** Tenants that ran out of work. */
  deactivate: string[];
}

/**
 * A tenant may hold its fair share of the pool, rounded up, plus this many
 * workers. The slack lets virtual time repay small debts: rounding, and the
 * idle gap between two short jobs. With 0, a tenant with 50 ms jobs got
 * 12.4% of worker time instead of its 14.3% in simulation.
 */
export const CAP_SLACK = 1;

/** Most workers a tenant may hold while other tenants are waiting. */
export function cap(pool: number, weight: number, totalWeight: number): number {
  return Math.ceil((pool * weight) / totalWeight) + CAP_SLACK;
}

/** One scheduler pass: who becomes active, and who gets the free workers. */
export function decide(
  tenants: TenantSnapshot[],
  totalSlots: number,
): Decision {
  const hasWork = (t: TenantSnapshot) => t.waiting > 0 || t.running > 0;
  // Usage so far, per unit of weight. Running jobs count, otherwise a
  // 5 minute job would look free until it ends.
  const usage = (t: TenantSnapshot, vtime = t.vtime) =>
    vtime + t.runningSeconds / t.weight;

  // 1. A tenant that was idle earns no credit for the time it was away.
  //    It restarts from the lowest usage among tenants that kept working.
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

  // 2. Hand out the free worker slots.
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

function dispatchFreeSlots(
  tenants: Contender[],
  totalSlots: number,
): Map<string, number> {
  const dispatch = new Map<string, number>();
  let free = totalSlots - sum(tenants, (t) => t.running);

  while (free > 0) {
    const waiting = tenants.filter((t) => t.waiting > 0);
    if (waiting.length === 0) break;

    // Workers held by tenants with nothing waiting are not up for sharing.
    // The rest is the pool that the waiting tenants split by weight.
    const settled = tenants.filter((t) => t.waiting === 0);
    const pool = totalSlots - sum(settled, (t) => t.running);
    const totalWeight = sum(waiting, (t) => t.weight);

    const next = pickNext(waiting, pool, totalWeight);
    // Cannot be undefined: the caps add up to more than the pool, so while
    // a worker is free at least one waiting tenant is under its cap.
    if (!next) break;

    next.running += 1;
    next.waiting -= 1;
    free -= 1;
    dispatch.set(next.id, (dispatch.get(next.id) ?? 0) + 1);
  }
  return dispatch;
}

/** Who gets the next free worker: lowest usage among tenants under cap. */
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

function comesBefore(a: Contender, b: Contender): boolean {
  if (a.usage !== b.usage) return a.usage < b.usage;
  // Same usage, typical for tenants that arrived together: the one with
  // fewer running jobs per unit of weight goes first, so they take turns.
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
