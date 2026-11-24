import pg from "pg";
import { config } from "./config.ts";

export type Db = pg.Pool;

export function connect(maxConnections = 10): Db {
  const db = new pg.Pool({
    connectionString: config.databaseUrl,
    max: maxConnections,
  });
  // An idle connection drops when Postgres restarts. Log it and let the pool open a new one.
  db.on("error", (err) =>
    console.error("postgres connection lost:", err.message),
  );
  return db;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
