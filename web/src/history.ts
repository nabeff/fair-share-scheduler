// What the page remembers about the pool: one sample a second, for the last
// minute. Plain functions on plain data, so the rules can be tested without a
// browser. usePool.ts feeds them, the chart and the table read the result.

import type { Pool } from "./api.ts";

/** One answer of GET /pool, and when it was asked for (ms since 1970). */
export interface Sample {
  at: number;
  pool: Pool;
}

export interface History {
  /** Oldest first. None is older than the window. */
  samples: readonly Sample[];
  /**
   * Tenant id to color number. Up to eight tenants each get one at once, in
   * the order of the list. With more, colors go to tenants in the order they
   * first had work. It only grows: a tenant never changes color while the
   * page is open.
   */
  colors: ReadonlyMap<string, number>;
}

export const emptyHistory: History = { samples: [], colors: new Map() };

export const WINDOW_SECONDS = 60;

/**
 * Tenants with a color of their own. Eight colors can be told apart, also
 * by people who do not see all colors. A ninth would look like one of them,
 * so the ninth tenant and all after it share one grey part named OTHER.
 */
export const OWN_COLORS = 8;
export const OTHER = "other";

/** Whole seconds between a sample and the newest one. */
const secondsAgo = (newest: Sample, sample: Sample) =>
  Math.round((newest.at - sample.at) / 1000);

/** The history with one more sample. */
export function addSample(history: History, sample: Sample): History {
  const samples = [...history.samples, sample].filter(
    (earlier) => secondsAgo(sample, earlier) < WINDOW_SECONDS,
  );
  const colors = new Map(history.colors);
  const fewTenants = sample.pool.tenants.length <= OWN_COLORS;
  for (const tenant of sample.pool.tenants) {
    const hasWork = tenant.running > 0 || tenant.waiting > 0;
    if ((fewTenants || hasWork) && !colors.has(tenant.id)) {
      colors.set(tenant.id, colors.size);
    }
  }
  return { samples, colors };
}

/** One piece of a stacked column: the workers one tenant held. */
export interface Part {
  /** A tenant id, or OTHER. */
  key: string;
  /** 0 to 7 for a color of its own, 8 for the shared grey. */
  color: number;
  workers: number;
}

/** One second of the chart. */
export interface Column {
  /** Seconds before the newest sample. 0 is now. */
  ago: number;
  /** Null when no answer arrived in that second: the column stays empty. */
  state: {
    /** Size of the pool. */
    slots: number;
    /** Workers that ran a job. */
    busy: number;
    /** In the order of the colors, so the stack never reshuffles. */
    parts: Part[];
  } | null;
}

/** The last minute as columns, from a minute ago (first) to now (last). */
export function toColumns(history: History): Column[] {
  const columns: Column[] = [];
  for (let ago = WINDOW_SECONDS - 1; ago >= 0; ago--) {
    columns.push({ ago, state: null });
  }
  const newest = history.samples.at(-1);
  if (!newest) return columns;

  // Samples are placed by their time, not by their number. A second without
  // an answer stays empty. Of two answers in one second, the later one wins.
  for (const sample of history.samples) {
    const column = columns[WINDOW_SECONDS - 1 - secondsAgo(newest, sample)];
    if (column) column.state = stack(sample.pool, history.colors);
  }
  return columns;
}

function stack(pool: Pool, colors: ReadonlyMap<string, number>) {
  const parts: Part[] = [];
  let others = 0;
  for (const tenant of pool.tenants) {
    if (tenant.running === 0) continue;
    const color = colors.get(tenant.id) ?? OWN_COLORS;
    if (color < OWN_COLORS) {
      parts.push({ key: tenant.id, color, workers: tenant.running });
    } else {
      others += tenant.running;
    }
  }
  parts.sort((a, b) => a.color - b.color);
  if (others > 0) {
    parts.push({ key: OTHER, color: OWN_COLORS, workers: others });
  }
  const busy = parts.reduce((sum, part) => sum + part.workers, 0);
  return { slots: pool.slots, busy, parts };
}

/**
 * Each tenant's part of the worker time that was used in the window, from 0
 * to 1. This is the measure of fairness of the scheduler: while several
 * tenants have jobs waiting, the shares follow their weights.
 */
export function workerTimeShares(
  samples: readonly Sample[],
): Map<string, number> {
  const held = new Map<string, number>();
  let total = 0;
  for (const { pool } of samples) {
    for (const tenant of pool.tenants) {
      held.set(tenant.id, (held.get(tenant.id) ?? 0) + tenant.running);
      total += tenant.running;
    }
  }
  for (const [id, workers] of held) {
    held.set(id, total === 0 ? 0 : workers / total);
  }
  return held;
}
