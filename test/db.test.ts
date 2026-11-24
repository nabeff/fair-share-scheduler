// What connect() promises about a connection to Postgres. No table is read
// or written here: the tests only open connections, so they use the database
// of the configuration. Needs the database from docker compose:
// docker compose up -d db

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import pg from "pg";
import { config } from "../src/config.ts";
import { connect, refusedByPostgres, sleep } from "../src/db.ts";
import { postgresIsUp } from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

// Trying again helps when Postgres was away, not when it said no.
test("an error tells if Postgres was away or refused the statement", () => {
  const answer = (sqlState: string) =>
    Object.assign(new pg.DatabaseError("an answer", 0, "error"), {
      code: sqlState,
    });

  // No answer at all: a broken connection, a call that timed out.
  assert.equal(refusedByPostgres(new Error("Query read timeout")), false);
  // "Not now": starting up, shut down, out of connections, statement
  // cancelled for being slow, picked to break a deadlock.
  for (const sqlState of ["57P03", "57P01", "53300", "57014", "40P01"]) {
    assert.equal(refusedByPostgres(answer(sqlState)), false, sqlState);
  }
  // About the statement itself: a number out of range, a broken rule, a typo.
  for (const sqlState of ["22003", "23503", "42601"]) {
    assert.equal(refusedByPostgres(answer(sqlState)), true, sqlState);
  }
});

describe("a connection from connect()", { skip }, () => {
  const db = connect(2);
  after(() => db.end());

  // What a scheduler pass can meet: Postgres restarts, or ends the session,
  // while the pass is between two statements. pg reports that as an "error"
  // event on the connection, and an event nobody listens to ends the process.
  test("closed by Postgres between two statements, it does not stop the process", async () => {
    const tx = await db.connect();
    try {
      const { rows } = await tx.query("SELECT pg_backend_pid() AS pid");
      await db.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
      await sleep(200); // the news reaches the connection while it is idle

      await assert.rejects(tx.query("SELECT 1"));
    } finally {
      tx.release(true);
    }
  });

  // The limits are settings of the connection, so Postgres applies them by
  // itself, also to a process that is frozen or gone.
  test("it carries the time limits", async () => {
    const { rows } = await db.query(
      `SELECT name, setting AS ms FROM pg_settings
       WHERE name IN ('statement_timeout',
                      'idle_in_transaction_session_timeout')
       ORDER BY name`,
    );
    const limit = String(config.dbTimeoutMs);
    assert.deepEqual(rows, [
      { name: "idle_in_transaction_session_timeout", ms: limit },
      { name: "statement_timeout", ms: limit },
    ]);
  });
});
