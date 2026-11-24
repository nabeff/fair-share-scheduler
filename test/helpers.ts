// Helpers for the tests that need a real Postgres and real processes.

import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import { config } from "../src/config.ts";
import { sleep } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";

// Tests get their own database on the same server, so they never touch the
// jobs of a running system.
const TEST_DATABASE = "scheduler_test";
const urlFor = (database: string) =>
  config.databaseUrl.replace(/\/[^/]+$/, `/${database}`);
export const testDatabaseUrl = urlFor(TEST_DATABASE);

/** True if Postgres answers. Tests that need it are skipped otherwise. */
export async function postgresIsUp(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: urlFor("postgres"),
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** An empty test database with the schema and the seeded tenants. */
export async function freshDatabase(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  const found = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [TEST_DATABASE],
  );
  if (found.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  }
  await admin.end();

  const db = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
  await db.query("DROP TABLE IF EXISTS jobs, workers, tenants");
  await migrate(db);
  return db;
}

// Short timings, so a crash is noticed in about a second instead of ten.
const FAST_SETTINGS = {
  LEASE_MS: "1500",
  HEARTBEAT_MS: "300",
  BACKOFF_MS: "200",
  TICK_MS: "20",
  LOG_EVERY_MS: "3600000",
};

/** Starts a real scheduler or worker process on the test database. */
export function start(
  script: "scheduler" | "worker",
  settings: Record<string, string> = {},
): ChildProcess {
  const file = new URL(`../src/${script}.ts`, import.meta.url).pathname;
  return spawn(process.execPath, [file], {
    env: {
      ...process.env,
      ...FAST_SETTINGS,
      ...settings,
      DATABASE_URL: testDatabaseUrl,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export async function submit(
  db: pg.Pool,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { rows } = await db.query(
    "INSERT INTO jobs (tenant_id, payload) VALUES ($1, $2) RETURNING id",
    [tenantId, payload],
  );
  return rows[0].id;
}

export async function getJob(db: pg.Pool, id: string) {
  const { rows } = await db.query("SELECT * FROM jobs WHERE id = $1", [id]);
  return rows[0];
}

/** For waitFor: gives the job once it has reached the status. */
export function jobIs(db: pg.Pool, id: string, status: string) {
  return async () => {
    const job = await getJob(db, id);
    return job.status === status ? job : undefined;
  };
}

/** Polls until the check returns a value. Fails the test after the timeout. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
