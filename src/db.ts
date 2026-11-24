import pg from "pg";
import { config } from "./config.ts";

export type Db = pg.Pool;

// No call waits forever. A Postgres that stopped answering (a frozen server,
// a network that swallows packets) must look like one that is down: the call
// fails, and the caller retries or answers 503. The connection that timed out
// is closed, the next call opens a new one.
export function connect(maxConnections = 10): Db {
  const db = new pg.Pool({
    connectionString: config.databaseUrl,
    max: maxConnections,
    // How long we wait for a connection, and for the answer to a query.
    connectionTimeoutMillis: config.dbTimeoutMs,
    query_timeout: config.dbTimeoutMs,
    // Postgres gives up on a statement after the same time, so it does not
    // finish work that nobody is waiting for any more.
    statement_timeout: config.dbTimeoutMs,
    // And it ends a transaction whose owner stays silent between two
    // statements for that long. A scheduler that froze in the middle of a
    // pass does not keep its lock and its rows.
    idle_in_transaction_session_timeout: config.dbTimeoutMs,
  });
  // An idle connection drops when Postgres restarts. Log it and let the pool open a new one.
  db.on("error", (err) =>
    console.error("postgres connection lost:", err.message),
  );
  // A connection in use can drop too, between two statements of the
  // scheduler's transaction. pg reports that as an "error" event on the
  // connection, and an event nobody listens to ends the process. Nothing to do
  // here: the next statement on that connection fails, and the pool drops it.
  db.on("connect", (connection) => connection.on("error", () => {}));
  return db;
}

// A failed call means one of two things. Postgres was away: it could not be
// reached, it did not answer in time, or it answered "not now" (it is
// starting or stopping, out of connections, it cancelled a slow statement or
// broke a deadlock). The same call can work a moment later. Or Postgres
// refused the statement itself, and it will refuse it every time.
const NOT_NOW = ["08", "40", "53", "57"]; // classes of SQLSTATE codes
export function refusedByPostgres(err: unknown): boolean {
  if (!(err instanceof pg.DatabaseError)) return false; // no answer at all
  return !NOT_NOW.includes(err.code?.slice(0, 2) ?? "");
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
