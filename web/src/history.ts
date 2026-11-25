// The last minute of pool samples. Plain functions, easy to test.

import type { Pool } from "./api.ts";

/** A GET /pool answer and when it was asked for. */
export interface Sample {
  at: number;
  pool: Pool;
}

export interface History {
  /** Oldest first. */
  samples: readonly Sample[];
  /** Tenant id to color index. A tenant never changes color. */
  colors: ReadonlyMap<string, number>;
}

export const emptyHistory: History = { samples: [], colors: new Map() };

export const WINDOW_SECONDS = 60;

/** Only 8 colors are distinct enough. The 9th tenant on shares grey. */
export const OWN_COLORS = 8;
export const OTHER = "other";

const secondsAgo = (newest: Sample, sample: Sample) =>
  Math.round((newest.at - sample.at) / 1000);

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

export interface Part {
  key: string;
  /** 0 to 7, or 8 for grey. */
  color: number;
  workers: number;
}

export interface Column {
  /** 0 is now. */
  ago: number;
  /** Null when no answer came that second. */
  state: {
    slots: number;
    busy: number;
    /** In color order, so stacks don't reshuffle. */
    parts: Part[];
  } | null;
}

/** Oldest column first. */
export function toColumns(history: History): Column[] {
  const columns: Column[] = [];
  for (let ago = WINDOW_SECONDS - 1; ago >= 0; ago--) {
    columns.push({ ago, state: null });
  }
  const newest = history.samples.at(-1);
  if (!newest) return columns;

  // Place samples by time, so a missed second stays empty.
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

/** Each tenant's share of the worker time in the window, 0 to 1. */
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
