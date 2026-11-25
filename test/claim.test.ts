// How a worker takes jobs, on a real Postgres.
// Needs the database from docker compose: docker compose up -d db

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_SQL } from "../src/worker.ts";
import { freshDatabase, postgresIsUp } from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

// A worker asks for as many jobs as it has free slots. Postgres chooses how
// to run a statement from its statistics of the table. With the statistics
// of a table that held one row, it once ran the part that picks the jobs
// again for every row, and a claim for 5 took all 20.
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
