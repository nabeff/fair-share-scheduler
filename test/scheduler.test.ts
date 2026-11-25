// The brief: the scheduler must not read the job duration.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { leaseGrace } from "../src/scheduler.ts";

test("the scheduling code never touches the payload", async () => {
  for (const file of ["scheduler.ts", "fairshare.ts"]) {
    const source = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      source.toLowerCase().includes("payload"),
      false,
      `${file} mentions the payload`,
    );
  }
});

// leaseGrace() on a fake clock.
describe("the wait before leases are judged", () => {
  const LEASE = 10_000;
  function setUp() {
    let now = 0;
    const grace = leaseGrace(LEASE, () => now);
    return { grace, at: (ms: number) => void (now = ms) };
  }

  test("a scheduler that starts waits one lease", () => {
    const { grace, at } = setUp();
    assert.equal(grace.isOver(), false);

    at(9_999);
    grace.passWorked();
    assert.equal(grace.isOver(), false);
    at(10_000);
    assert.equal(grace.isOver(), true);
  });

  test("after an outage it starts when Postgres answers again", () => {
    const { grace, at } = setUp();
    at(60_000);
    grace.passWorked();
    assert.equal(grace.isOver(), true);

    at(61_000);
    grace.passFailed();
    assert.equal(grace.isOver(), false);
    at(67_000);
    grace.passWorked();

    // One lease from the answer, not from the failure.
    at(76_999);
    assert.equal(grace.isOver(), false);
    at(77_000);
    assert.equal(grace.isOver(), true);
  });

  test("passes that work do not push its end back", () => {
    const { grace, at } = setUp();
    grace.passFailed();
    at(1_000);
    grace.passWorked();
    at(6_000);
    grace.passWorked();

    at(11_000);
    assert.equal(grace.isOver(), true);
  });

  test("a pass that fails during the wait starts it again", () => {
    const { grace, at } = setUp();
    grace.passFailed();
    at(1_000);
    grace.passWorked();
    at(5_000);
    grace.passFailed();
    at(30_000);
    grace.passWorked();

    at(39_999);
    assert.equal(grace.isOver(), false);
    at(40_000);
    assert.equal(grace.isOver(), true);
  });
});
