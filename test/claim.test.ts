// Needs: docker compose up -d db

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_SQL } from "../src/worker.ts";
import { freshDatabase, postgresIsUp } from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

// With stats saying the table has one row, the old query ran the pick once
// per row, and a claim for 5 took all 20.
test("a claim never takes more jobs than it asked for", { skip }, async () => {
  const db = await freshDatabase("scheduler_test_claim");
  try {
    await db.query(
      `INSERT INTO jobs (tenant_id, payload, status, started_at, finished_at)
         VALUES ('cafe', '{}', 'succeeded', now(), now())`,
    );
    await db.query("VACUUM ANALYZE jobs"); // statistics: one row
    await db.query(
      `INSERT INTO jobs (tenant_id, payload, status, ready_at)
         SELECT 'cafe', '{}', 'ready', now() FROM generate_series(1, 20)`,
    );

    const { rows } = await db.query(CLAIM_SQL, ["worker-1", 10_000, 5]);

    assert.equal(rows.length, 5);
    const taken = await db.query(
      "SELECT count(*)::int AS n FROM jobs WHERE status = 'running'",
    );
    assert.equal(taken.rows[0].n, 5);
  } finally {
    await db.end();
  }
});
