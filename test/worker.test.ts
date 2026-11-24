// What happens to a job after an attempt: retry, give up, or done.

import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { outcomeOf } from "../src/worker.ts";

test("an attempt without error succeeds", () => {
  assert.deepEqual(outcomeOf(1, 3, null), {
    status: "succeeded",
    retryInMs: 0,
  });
});

test("a failed attempt is retried with exponential backoff", () => {
  assert.deepEqual(outcomeOf(1, 3, "boom"), {
    status: "failed",
    retryInMs: config.backoffMs,
  });
  assert.deepEqual(outcomeOf(2, 3, "boom"), {
    status: "failed",
    retryInMs: config.backoffMs * 2,
  });
});

test("the last allowed attempt failing makes the job dead", () => {
  assert.deepEqual(outcomeOf(3, 3, "boom"), { status: "dead", retryInMs: 0 });
});
