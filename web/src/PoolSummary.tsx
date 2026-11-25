import type { Pool } from "./api.ts";
import { count } from "./format.ts";

/** The pool in four numbers. */
export function PoolSummary({ pool }: { pool: Pool | null }) {
  const busy = pool?.tenants.reduce((sum, t) => sum + t.running, 0) ?? 0;
  const waiting = pool?.tenants.reduce((sum, t) => sum + t.waiting, 0) ?? 0;
  const slots = pool?.slots ?? 0;
  const tiles = [
    ["Workers in the pool", slots],
    ["Busy", busy],
    ["Idle", Math.max(0, slots - busy)],
    ["Jobs waiting", waiting],
  ] as const;

  return (
    <dl className="tiles pool-data">
      {tiles.map(([label, value]) => (
        <div key={label} className="tile">
          <dt>{label}</dt>
          {/* Before the first answer there is no number to show, not a zero. */}
          <dd>{pool ? count(value) : "..."}</dd>
        </div>
      ))}
    </dl>
  );
}
