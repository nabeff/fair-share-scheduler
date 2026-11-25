import pg from "pg";
import { config } from "./config.ts";

export type Db = pg.Pool;

// Every call has a timeout, so a frozen Postgres looks like a down one
// and callers can retry.
export function connect(maxConnections = 10): Db {
  const db = new pg.Pool({
    connectionString: config.databaseUrl,
    max: maxConnections,
    connectionTimeoutMillis: config.dbTimeoutMs,
    query_timeout: config.dbTimeoutMs,
    statement_timeout: config.dbTimeoutMs,
    // A scheduler that froze mid-transaction must not keep its lock.
    idle_in_transaction_session_timeout: config.dbTimeoutMs,
  });
  // Connections drop when Postgres restarts. Without these listeners
  // the process would crash; the pool replaces the connection instead.
  db.on("error", (err) =>
    console.error("postgres connection lost:", err.message),
  );
  db.on("connect", (connection) => connection.on("error", () => {}));
  return db;
}

// True when Postgres rejected the statement itself, so retrying won't help.
// These SQLSTATE classes mean "try again later" instead: connection lost,
// deadlock, out of resources, shutting down.
const NOT_NOW = ["08", "40", "53", "57"];
export function refusedByPostgres(err: unknown): boolean {
  if (!(err instanceof pg.DatabaseError)) return false; // no answer at all
  return !NOT_NOW.includes(err.code?.slice(0, 2) ?? "");
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
