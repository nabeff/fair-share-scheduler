import { describe, expect, test } from "vitest";
import {
  addSample,
  emptyHistory,
  OTHER,
  toColumns,
  workerTimeShares,
  type History,
  type Sample,
} from "./history.ts";

/** A sample taken `second` seconds after the start, with these running jobs. */
function sample(second: number, running: Record<string, number>): Sample {
  const tenants = Object.entries(running).map(([id, jobs]) => ({
    id,
    weight: 1,
    running: jobs,
    waiting: 0,
  }));
  return { at: second * 1000, pool: { slots: 20, tenants } };
}

/** Eight tenants without work, so a pool has more tenants than colors. */
const idle: Record<string, number> = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`idle-${i + 1}`, 0]),
);

const historyOf = (...samples: Sample[]): History =>
  samples.reduce(addSample, emptyHistory);

/** The column of `ago` seconds ago. */
const column = (history: History, ago: number) =>
  toColumns(history).find((c) => c.ago === ago)?.state;

describe("the history of the pool", () => {
  test("keeps the last minute and drops what is older", () => {
    let history = emptyHistory;
    for (let second = 0; second <= 70; second++) {
      history = addSample(history, sample(second, { supermarket: 1 }));
    }

    expect(history.samples).toHaveLength(60);
    expect(history.samples[0]?.at).toBe(11_000);
    expect(toColumns(history)).toHaveLength(60);
  });

  test("the chart goes from a minute ago to now", () => {
    const history = historyOf(
      sample(0, { supermarket: 3 }),
      sample(1, { supermarket: 5 }),
    );

    const columns = toColumns(history);
    expect(columns[0]?.ago).toBe(59);
    expect(columns.at(-1)?.ago).toBe(0);
    expect(column(history, 0)).toEqual({
      slots: 20,
      busy: 5,
      parts: [{ key: "supermarket", color: 0, workers: 5 }],
    });
    expect(column(history, 1)?.busy).toBe(3);
  });

  // The API was down, or the laptop was asleep. The chart must not pretend
  // that the samples before and after touch each other.
  test("a second without an answer is a hole in the chart", () => {
    const history = historyOf(
      sample(0, { supermarket: 3 }),
      sample(1, { supermarket: 4 }),
      sample(4, { supermarket: 5 }),
    );

    expect(column(history, 0)?.busy).toBe(5);
    expect(column(history, 1)).toBeNull();
    expect(column(history, 2)).toBeNull();
    expect(column(history, 3)?.busy).toBe(4);
    expect(column(history, 4)?.busy).toBe(3);
  });

  test("of two answers in the same second, the newer one counts", () => {
    const history = historyOf(
      sample(0, { supermarket: 3 }),
      sample(0.2, { supermarket: 7 }),
      sample(1.1, { supermarket: 9 }),
    );

    expect(column(history, 1)?.busy).toBe(7);
  });

  // Eight colors can be told apart, so up to eight tenants each get one at
  // once, also the ones without work. The table then has a key for every row.
  test("with eight tenants or fewer, every tenant has a color from the start", () => {
    const history = historyOf(sample(0, { supermarket: 0, cafe: 0, bank: 2 }));

    expect([...history.colors]).toEqual([
      ["supermarket", 0],
      ["cafe", 1],
      ["bank", 2],
    ]);
  });

  test("with more tenants, a tenant gets a color when it first has work, and keeps it", () => {
    let history = historyOf(sample(0, { supermarket: 0, bank: 2, ...idle }));
    expect([...history.colors]).toEqual([["bank", 0]]);

    history = addSample(
      history,
      sample(1, { supermarket: 5, bank: 0, ...idle }),
    );
    history = addSample(
      history,
      sample(2, { supermarket: 5, bank: 1, ...idle }),
    );
    expect([...history.colors]).toEqual([
      ["bank", 0],
      ["supermarket", 1],
    ]);
    // The stack keeps the order of the colors, whoever holds more.
    expect(column(history, 0)?.parts).toEqual([
      { key: "bank", color: 0, workers: 1 },
      { key: "supermarket", color: 1, workers: 5 },
    ]);
  });

  test("a tenant with jobs that only wait has work too", () => {
    const waiting = { id: "hotel", weight: 2, running: 0, waiting: 9 };
    const others = sample(0, idle).pool.tenants;
    const history = addSample(emptyHistory, {
      at: 0,
      pool: { slots: 20, tenants: [...others, waiting] },
    });

    expect(history.colors.get("hotel")).toBe(0);
  });

  // The palette has eight colors that can be told apart. A ninth would not be.
  test("after eight tenants, the others share one part of the stack", () => {
    const running: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) running[`tenant-${i}`] = i;
    const history = historyOf(sample(0, running));

    const parts = column(history, 0)?.parts ?? [];
    expect(parts).toHaveLength(9);
    expect(parts.at(-1)).toEqual({ key: OTHER, color: 8, workers: 9 + 10 });
  });

  test("the share of worker time follows what each tenant held", () => {
    const steady = {
      bank: 4,
      hotel: 2,
      school: 1,
      idle: 0,
    };
    const history = historyOf(
      sample(0, steady),
      sample(1, steady),
      sample(2, steady),
    );

    const shares = workerTimeShares(history.samples);
    expect(shares.get("bank")).toBeCloseTo(4 / 7);
    expect(shares.get("hotel")).toBeCloseTo(2 / 7);
    expect(shares.get("school")).toBeCloseTo(1 / 7);
    expect(shares.get("idle")).toBe(0);
  });

  test("when no worker was used, every share is zero", () => {
    const history = historyOf(sample(0, { supermarket: 0 }));

    expect(workerTimeShares(history.samples).get("supermarket")).toBe(0);
  });
});
