// Settings come from the environment. The config is read when a process
// starts, so each case starts a small process of its own.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const configUrl = new URL("../src/config.ts", import.meta.url).href;
const printLease =
  "const { config } = await import(process.argv[1]); console.log(config.leaseMs);";

function startWith(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", printLease, configUrl],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
}

test("a setting that is not a number stops the process and names the variable", () => {
  const result = startWith({ LEASE_MS: "ten seconds" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LEASE_MS must be a number/);
});

test("an empty setting falls back to its default", () => {
  const result = startWith({ LEASE_MS: "" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "10000");
});

test("a valid setting is used", () => {
  const result = startWith({ LEASE_MS: "30000" });
  assert.equal(result.stdout.trim(), "30000");
});
