// Fairness over time, checked on a simulated pool of 20 workers.
// These tests run the real decide() function against a model of the workers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cap } from "../src/fairshare.ts";
import { between, simulate, type SimTenant } from "./simulate.ts";

const SLOTS = 20;

/** A tenant that never runs out of jobs. */
function backlogged(
  id: string,
  weight: number,
  seconds: (random: () => number) => number,
  at = 0,
): SimTenant {
  return { id, weight, batches: [{ at, count: 200_000, seconds }] };
}

test("flood: small tenants start within a second of submitting", () => {
  const smallBatches = [5, 7, 8, 10];
  const result = simulate({
    slots: SLOTS,
    duration: 75,
    tenants: [
      {
        id: "supermarket",
        weight: 1,
        batches: [{ at: 0, count: 100_000, seconds: between(0.05, 0.5) }],
      },
      ...smallBatches.map((count, i) => ({
        id: `small-${i + 1}`,
        weight: 1,
        batches: [{ at: 60, count, seconds: between(0.1, 0.4) }],
      })),
    ],
  });

  // Alone for the first minute, the big tenant used every worker.
  assert.equal(result.supermarket.peakRunning, SLOTS);

  smallBatches.forEach((count, i) => {
    const waits = result[`small-${i + 1}`].waits;
    assert.equal(waits.length, count, "every job of the small tenant started");
    assert.ok(Math.max(...waits) < 1, `waited ${Math.max(...waits)} s`);
  });
});

test("weights 1, 2, 4: worker time follows the weights, not job length", () => {
  const result = simulate({
    slots: SLOTS,
    duration: 300,
    tenants: [
      backlogged("school", 1, between(0.05, 0.15)),
      backlogged("hotel", 2, between(0.2, 0.8)),
      backlogged("bank", 4, between(1, 3)),
    ],
  });

  assertClose(result["school"].share, 1 / 7, 0.01);
  assertClose(result["hotel"].share, 2 / 7, 0.01);
  assertClose(result["bank"].share, 4 / 7, 0.01);
  // Fair in time is not fair in job count: school ran many more jobs.
  assert.ok(result["school"].completed > 4 * result["bank"].completed);
});

test("a tenant with only 5 minute jobs cannot take every worker", () => {
  const fiveMinutes = between(280, 300);
  const result = simulate({
    slots: SLOTS,
    duration: 2400,
    measureFrom: 600,
    tenants: [
      backlogged("first", 1, fiveMinutes),
      backlogged("second", 1, fiveMinutes, 60),
    ],
  });

  // "first" was alone at the start and filled the pool. Once "second" has
  // work, neither may hold more than its capped share.
  assert.equal(result.first.peakRunning, SLOTS);
  assert.ok(result.second.peakRunning <= cap(SLOTS, 1, 2));
  assertClose(result.first.share, 0.5, 0.1);
  assertClose(result.second.share, 0.5, 0.1);
});

test("a tenant coming back from idle gets its share, not a burst", () => {
  const result = simulate({
    slots: SLOTS,
    duration: 660,
    measureFrom: 600, // the first minute after "returning" shows up
    tenants: [
      backlogged("steady", 1, between(0.5, 1.5)),
      backlogged("returning", 1, between(0.5, 1.5), 600),
    ],
  });

  assertClose(result.returning.share, 0.5, 0.03);
});

test("more tenants than workers: shares still follow the weights", () => {
  const weights = [1, 2, 4];
  const tenants = Array.from({ length: 60 }, (_, i) =>
    backlogged(`tenant-${i}`, weights[i % 3], between(0.1, 2)),
  );
  const totalWeight = tenants.reduce((n, t) => n + t.weight, 0);
  const result = simulate({ slots: SLOTS, duration: 400, tenants });

  for (const t of tenants) {
    const target = t.weight / totalWeight;
    const share = result[t.id].share;
    assert.ok(result[t.id].completed > 0, `${t.id} was starved`);
    assert.ok(
      Math.abs(share - target) / target < 0.15,
      `${t.id}: share ${share.toFixed(4)}, target ${target.toFixed(4)}`,
    );
  }
});

function assertClose(actual: number, expected: number, tolerance: number) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected.toFixed(3)} +/- ${tolerance}, got ${actual.toFixed(3)}`,
  );
}
