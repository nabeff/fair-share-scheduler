// The brief says the scheduler must not read the job duration from the
// payload. The scheduling code does not mention the payload at all.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
