import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { count } from "./format.ts";
import {
  OTHER,
  OWN_COLORS,
  toColumns,
  WINDOW_SECONDS,
  type Column,
  type History,
} from "./history.ts";
import { colorOf } from "./palette.ts";

const share = (part: number, whole: number) => `${(part / whole) * 100}%`;

/** Round steps (1, 2, 5, 10, ...) that draw at most five lines up to the top. */
export function ticksUpTo(top: number): number[] {
  const step =
    [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(
      (size) => top / size <= 5,
    ) ?? Math.ceil(top / 5);
  const ticks = [];
  for (let value = step; value <= top; value += step) ticks.push(value);
  return ticks;
}

/**
 * Who held the workers, second by second: one stacked column a second.
 *
 * The marks are plain boxes sized in percent, so the chart follows the width
 * of the page without measuring anything. Pointing at a column, or walking
 * with the arrow keys, reads the numbers of that second.
 */
export function PoolChart({ history }: { history: History }) {
  // The column that is read out, in seconds ago. It follows the position, not
  // the sample: "10 s ago" stays "10 s ago" while the samples move through.
  const [selected, setSelected] = useState<number | null>(null);

  const columns = toColumns(history);
  // The scale ends at the size of the pool. Right after a worker is stopped,
  // more jobs can count as running than the pool has slots: then it ends there.
  const top = Math.max(
    1,
    ...columns.map(({ state }) =>
      state ? Math.max(state.slots, state.busy) : 0,
    ),
  );
  const selectedIndex = columns.findIndex(({ ago }) => ago === selected);
  const selectedColumn = columns[selectedIndex];
  // What an empty plot says. Before the first sample nothing is known, not
  // even the size of the pool, so the plot has no scale either.
  const waiting = history.samples.length === 0;
  const note = waiting
    ? "No samples yet."
    : columns.every(({ state }) => !state || state.busy === 0)
      ? "No job is running."
      : null;

  function point(event: PointerEvent) {
    const column = (event.target as Element).closest<HTMLElement>("[data-ago]");
    // Between two columns there is a small gap. Keep the last column there.
    if (column) setSelected(Number(column.dataset.ago));
  }

  function walk(event: KeyboardEvent) {
    if (event.key === "Escape") return setSelected(null);
    const step = { ArrowLeft: 1, ArrowRight: -1 }[event.key];
    const jump = { Home: WINDOW_SECONDS - 1, End: 0 }[event.key];
    if (step === undefined && jump === undefined) return;
    event.preventDefault(); // do not scroll the page
    // From the value of the moment, not the one this render saw: two key
    // presses can arrive before the chart is drawn again.
    setSelected((current) => {
      const to = jump ?? (current ?? 0) + (step ?? 0);
      return Math.min(WINDOW_SECONDS - 1, Math.max(0, to));
    });
  }

  return (
    <figure className="chart">
      <figcaption>
        <h2>Workers held by each tenant</h2>
        <p>Each column is one second. Empty space means idle workers.</p>
      </figcaption>

      <Legend colors={history.colors} columns={columns} />

      <div className="plot-area">
        <div
          className={selectedColumn ? "plot plot-reading" : "plot"}
          role="group"
          aria-label="Workers held by each tenant, second by second, for the last minute. The left and right arrow keys read one second. The table below has the numbers of this moment."
          tabIndex={0}
          onPointerMove={point}
          onPointerDown={point}
          // A finger "leaves" the moment it is lifted. The column it tapped
          // stays read out until the chart loses the focus.
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") setSelected(null);
          }}
          onFocus={() => setSelected((current) => current ?? 0)}
          onBlur={() => setSelected(null)}
          onKeyDown={walk}
        >
          {(waiting ? [] : ticksUpTo(top)).map((value) => (
            <div
              key={value}
              className="gridline"
              style={{ bottom: share(value, top) }}
              aria-hidden="true"
            >
              <span>{count(value)}</span>
            </div>
          ))}

          {columns.map((column) => (
            <StackedColumn
              key={column.ago}
              column={column}
              top={top}
              selected={column.ago === selected}
            />
          ))}

          {note && <p className="plot-note">{note}</p>}
          {selectedColumn && (
            <Readout column={selectedColumn} index={selectedIndex} />
          )}
        </div>

        <div className="time-axis" aria-hidden="true">
          {[60, 45, 30, 15, 0].map((ago) => (
            <span key={ago} style={{ left: `${100 - (ago / 60) * 100}%` }}>
              {ago === 60 ? "60 s ago" : ago === 0 ? "now" : `${ago} s`}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

/**
 * Names the colors that are in the chart right now. A tenant keeps its color
 * for good, but it is only listed while one of the columns shows it.
 */
function Legend(props: {
  colors: ReadonlyMap<string, number>;
  columns: Column[];
}) {
  const inChart = new Set(
    props.columns.flatMap(({ state }) => state?.parts.map((p) => p.key) ?? []),
  );
  const tenants = [...props.colors].filter(([tenant]) => inChart.has(tenant));
  return (
    <ul className="legend" aria-label="Legend">
      <li>
        <i className="key key-line" />
        Pool size
      </li>
      {tenants.map(([tenant, color]) => (
        <li key={tenant}>
          <i className="key" style={{ background: colorOf(color) }} />
          {tenant}
        </li>
      ))}
      {inChart.has(OTHER) && (
        <li>
          <i className="key" style={{ background: colorOf(OWN_COLORS) }} />
          Other tenants
        </li>
      )}
    </ul>
  );
}

function StackedColumn(props: {
  column: Column;
  top: number;
  selected: boolean;
}) {
  const { ago, state } = props.column;
  return (
    <div
      className={props.selected ? "column column-selected" : "column"}
      data-ago={ago}
      aria-hidden="true"
    >
      {state?.parts.map((part, index) => (
        <i
          key={part.key}
          className={
            index === state.parts.length - 1 ? "segment segment-top" : "segment"
          }
          data-part={part.key}
          style={{
            height: share(part.workers, props.top),
            background: colorOf(part.color),
          }}
        />
      ))}
      {state && (
        <i
          className="pool-line"
          style={{ bottom: `calc(${share(state.slots, props.top)} - 2px)` }}
        />
      )}
    </div>
  );
}

/** The numbers of one second, beside its column. */
function Readout({ column, index }: { column: Column; index: number }) {
  const { ago, state } = column;
  // On the side of the column that has room.
  const middle = ((index + 0.5) / WINDOW_SECONDS) * 100;
  const place =
    middle < 50
      ? { left: `calc(${middle}% + 14px)` }
      : { right: `calc(${100 - middle}% + 14px)` };

  return (
    <div className="readout" role="status" style={place}>
      <p className="readout-when">{ago === 0 ? "Now" : `${ago} s ago`}</p>
      {state ? (
        <>
          <ul>
            {state.parts.map((part) => (
              <li key={part.key}>
                <i
                  className="key key-line"
                  style={{ background: colorOf(part.color) }}
                />
                <b>{count(part.workers)}</b>{" "}
                {part.key === OTHER ? "other tenants" : part.key}
              </li>
            ))}
            <li>
              <i className="key key-line key-none" />
              <b>{count(Math.max(0, state.slots - state.busy))}</b> idle
            </li>
          </ul>
          <p className="readout-pool">Pool of {count(state.slots)} workers</p>
        </>
      ) : (
        <p>No sample in this second.</p>
      )}
    </div>
  );
}
