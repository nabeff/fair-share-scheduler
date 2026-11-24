// Unit tests for the "who runs next" logic. No database, no clock.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cap,
  CAP_SLACK,
  decide,
  type TenantSnapshot,
} from "../src/fairshare.ts";

function tenant(
  id: string,
  over: Partial<TenantSnapshot> = {},
): TenantSnapshot {
  return {
    id,
    weight: 1,
    vtime: 0,
    active: true,
    running: 0,
    runningSeconds: 0,
    waiting: 0,
    ...over,
  };
}

function dispatched(tenants: TenantSnapshot[], slots: number) {
  return Object.fromEntries(decide(tenants, slots).dispatch);
}

test("a tenant alone uses every worker", () => {
  const result = dispatched([tenant("big", { waiting: 100_000 })], 20);
  assert.deepEqual(result, { big: 20 });
});

test("equal weights split the workers evenly", () => {
  const result = dispatched(
    [tenant("a", { waiting: 500 }), tenant("b", { waiting: 500 })],
    20,
  );
  assert.deepEqual(result, { a: 10, b: 10 });
});

test("workers follow the weights 1, 2 and 4", () => {
  const result = dispatched(
    [
      tenant("bronze", { weight: 1, waiting: 500 }),
      tenant("silver", { weight: 2, waiting: 500 }),
      tenant("gold", { weight: 4, waiting: 500 }),
    ],
    14,
  );
  assert.deepEqual(result, { bronze: 2, silver: 4, gold: 8 });
});

test("the tenant with the lowest usage gets the free worker", () => {
  const result = dispatched(
    [
      tenant("used-more", { vtime: 10, running: 1, waiting: 5 }),
      tenant("used-less", { vtime: 5, running: 1, waiting: 5 }),
    ],
    3,
  );
  assert.deepEqual(result, { "used-less": 1 });
});

test("usage is divided by weight", () => {
  // Same worker seconds used, but "gold" paid for four times the share.
  const result = dispatched(
    [
      tenant("bronze", { weight: 1, vtime: 40 / 1, running: 1, waiting: 5 }),
      tenant("gold", { weight: 4, vtime: 40 / 4, running: 1, waiting: 5 }),
    ],
    3,
  );
  assert.deepEqual(result, { gold: 1 });
});

test("jobs that are still running count as usage", () => {
  // "long" has finished nothing yet, but its job has held a worker for 100 s.
  const result = dispatched(
    [
      tenant("long", { vtime: 0, running: 1, runningSeconds: 100, waiting: 5 }),
      tenant("short", { vtime: 50, running: 1, waiting: 5 }),
    ],
    3,
  );
  assert.deepEqual(result, { short: 1 });
});

test("a tenant at its cap is skipped even with the lowest usage", () => {
  const atCap = cap(20, 1, 2);
  const result = dispatched(
    [
      tenant("hog", { vtime: 0, running: atCap, waiting: 500 }),
      tenant("other", { vtime: 1000, running: 20 - atCap - 1, waiting: 500 }),
    ],
    20,
  );
  assert.deepEqual(result, { other: 1 });
});

test("the cap never leaves a worker idle while jobs wait", () => {
  const result = dispatched(
    [
      tenant("a", { waiting: 500 }),
      tenant("b", { waiting: 500 }),
      tenant("tiny", { waiting: 1 }),
    ],
    20,
  );
  assert.equal(result.tiny, 1);
  assert.equal(result.a + result.b, 19);
  assert.ok(Math.abs(result.a - result.b) <= 1);
});

test("workers held by a tenant with nothing waiting are not shared out", () => {
  // "busy" holds 12 workers and has no more jobs. The other two split 8.
  const result = dispatched(
    [
      tenant("busy", { running: 12, waiting: 0 }),
      tenant("a", { waiting: 500 }),
      tenant("b", { waiting: 500 }),
    ],
    20,
  );
  assert.deepEqual(result, { a: 4, b: 4 });
});

test("never dispatches more jobs than a tenant has waiting", () => {
  assert.deepEqual(dispatched([tenant("a", { waiting: 3 })], 20), { a: 3 });
});

test("dispatches nothing when every worker is busy", () => {
  const result = dispatched(
    [
      tenant("a", { running: 10, waiting: 500 }),
      tenant("b", { running: 10, waiting: 500 }),
    ],
    20,
  );
  assert.deepEqual(result, {});
});

test("dispatches nothing when workers disappeared", () => {
  // 20 jobs are running but only 10 slots are still alive.
  const result = dispatched([tenant("a", { running: 20, waiting: 500 })], 10);
  assert.deepEqual(result, {});
});

test("tenants that arrive together take turns", () => {
  // Three free workers, three tenants with the same usage: one each.
  const result = dispatched(
    [
      tenant("big", { running: 17, waiting: 500, vtime: 900 }),
      tenant("s1", { waiting: 9, vtime: 100 }),
      tenant("s2", { waiting: 9, vtime: 100 }),
      tenant("s3", { waiting: 9, vtime: 100 }),
    ],
    20,
  );
  assert.deepEqual(result, { s1: 1, s2: 1, s3: 1 });
});

test("an idle tenant comes back level with the active ones, no credit", () => {
  const tenants = [
    tenant("worked", { vtime: 500, running: 10, waiting: 500 }),
    tenant("was-idle", { vtime: 3, active: false, waiting: 500 }),
  ];
  const decision = decide(tenants, 20);
  assert.equal(decision.activate.get("was-idle"), 500);
  // It gets its half of the workers, not all of them.
  assert.deepEqual(Object.fromEntries(decision.dispatch), { "was-idle": 10 });
});

test("the level it comes back at includes jobs still running", () => {
  const decision = decide(
    [
      tenant("worked", { vtime: 500, running: 2, runningSeconds: 60 }),
      tenant("was-idle", { vtime: 3, active: false, waiting: 5 }),
    ],
    20,
  );
  assert.equal(decision.activate.get("was-idle"), 560);
});

test("a returning tenant that used more keeps its own usage", () => {
  const decision = decide(
    [
      tenant("worked", { vtime: 500, waiting: 5 }),
      tenant("heavy", { vtime: 900, active: false, waiting: 5 }),
    ],
    20,
  );
  assert.equal(decision.activate.get("heavy"), 900);
});

test("with nobody active, a tenant starts from the highest known usage", () => {
  const decision = decide(
    [
      tenant("gone", { vtime: 800, active: false }),
      tenant("new", { vtime: 2, active: false, waiting: 5 }),
    ],
    20,
  );
  assert.equal(decision.activate.get("new"), 800);
  assert.equal(decision.activate.has("gone"), false);
});

test("a tenant with no work left is deactivated", () => {
  const decision = decide(
    [tenant("done", { vtime: 40 }), tenant("busy", { running: 1 })],
    20,
  );
  assert.deepEqual(decision.deactivate, ["done"]);
});

test("cap is the fair share rounded up, plus the slack", () => {
  assert.equal(cap(20, 1, 5), 4 + CAP_SLACK);
  assert.equal(cap(20, 1, 7), 3 + CAP_SLACK); // 2.86 rounds up to 3
  assert.equal(cap(20, 4, 7), 12 + CAP_SLACK); // 11.43 rounds up to 12
  assert.equal(cap(20, 1, 1), 20 + CAP_SLACK); // alone: the whole pool
  assert.equal(cap(20, 1, 1000), 1 + CAP_SLACK); // never below one worker
});
