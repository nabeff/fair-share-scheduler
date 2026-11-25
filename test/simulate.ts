// Simulated pool that drives the real decide() over simulated time.
// Only the model knows job lengths, decide() never sees them.

import { decide, type TenantSnapshot } from "../src/fairshare.ts";

export interface Batch {
  /** Submit time, in seconds. */
  at: number;
  count: number;
  seconds: (random: () => number) => number;
}

export interface SimTenant {
  id: string;
  weight: number;
  batches: Batch[];
}

export interface SimOptions {
  slots: number;
  tenants: SimTenant[];
  duration: number;
  /** Measure from this second. Default 0. */
  measureFrom?: number;
  /** Measure until this second. Default: the end. */
  measureTo?: number;
  seed?: number;
}

export interface TenantResult {
  workerSeconds: number;
  /** 0 to 1. */
  share: number;
  /** Submit to start, per job, in seconds. */
  waits: number[];
  completed: number;
  peakRunning: number;
}

const TICK = 0.02; // seconds between two scheduler passes
const PICKUP_DELAY = 0.02; // a worker picks a dispatched job up within this

export function simulate(options: SimOptions): Record<string, TenantResult> {
  const random = seededRandom(options.seed ?? 1);
  const from = options.measureFrom ?? 0;
  const to = options.measureTo ?? options.duration;
  const measured = (start: number, end: number) =>
    Math.max(0, Math.min(end, to) - Math.max(start, from));

  const tenants = options.tenants.map((t) => ({
    id: t.id,
    weight: t.weight,
    vtime: 0,
    active: false,
    notSubmitted: [...t.batches],
    queue: [] as { submittedAt: number; seconds: number }[],
    queueHead: 0,
    running: [] as { start: number; end: number }[],
    result: {
      workerSeconds: 0,
      share: 0,
      waits: [],
      completed: 0,
      peakRunning: 0,
    } as TenantResult,
  }));

  const steps = Math.round(options.duration / TICK);
  for (let step = 0; step <= steps; step++) {
    const now = step * TICK;

    for (const t of tenants) {
      t.notSubmitted = t.notSubmitted.filter((batch) => {
        if (batch.at > now) return true;
        for (let i = 0; i < batch.count; i++) {
          t.queue.push({
            submittedAt: batch.at,
            seconds: batch.seconds(random),
          });
        }
        return false;
      });
      // Finished jobs: charge the tenant.
      t.running = t.running.filter((job) => {
        if (job.end > now) return true;
        t.vtime += (job.end - job.start) / t.weight;
        t.result.completed += 1;
        t.result.workerSeconds += measured(job.start, job.end);
        return false;
      });
    }

    const snapshot: TenantSnapshot[] = tenants.map((t) => ({
      id: t.id,
      weight: t.weight,
      vtime: t.vtime,
      active: t.active,
      running: t.running.length,
      runningSeconds: t.running.reduce(
        (total, job) => total + Math.max(0, now - job.start),
        0,
      ),
      waiting: t.queue.length - t.queueHead,
    }));
    const decision = decide(snapshot, options.slots);

    for (const t of tenants) {
      const startFrom = decision.activate.get(t.id);
      if (startFrom !== undefined) {
        t.vtime = startFrom;
        t.active = true;
      }
      if (decision.deactivate.includes(t.id)) t.active = false;

      const count = decision.dispatch.get(t.id) ?? 0;
      for (let i = 0; i < count; i++) {
        const job = t.queue[t.queueHead++];
        const start = now + random() * PICKUP_DELAY;
        t.result.waits.push(start - job.submittedAt);
        t.running.push({ start, end: start + job.seconds });
      }
      t.result.peakRunning = Math.max(t.result.peakRunning, t.running.length);
    }
  }

  // Jobs still running when the simulation stops.
  for (const t of tenants) {
    for (const job of t.running) {
      t.result.workerSeconds += measured(job.start, options.duration);
    }
  }
  const total = tenants.reduce((n, t) => n + t.result.workerSeconds, 0);
  for (const t of tenants) t.result.share = t.result.workerSeconds / total;

  return Object.fromEntries(tenants.map((t) => [t.id, t.result]));
}

export function between(min: number, max: number) {
  return (random: () => number) => min + random() * (max - min);
}

/** Seeded, so a failing run can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
