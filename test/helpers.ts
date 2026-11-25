import { spawn, type ChildProcess } from "node:child_process";
import {
  connect as openSocket,
  createServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../src/config.ts";
import { sleep } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";

// Tests use their own database, never the running system's.
const TEST_DATABASE = "scheduler_test";
export const urlFor = (database: string) =>
  config.databaseUrl.replace(/\/[^/]+$/, `/${database}`);
export const testDatabaseUrl = urlFor(TEST_DATABASE);

/** Tests that need Postgres are skipped without it. */
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

export async function freshDatabase(
  database = TEST_DATABASE,
): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  const found = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [database],
  );
  if (found.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${database}`);
  }
  await admin.end();

  const db = new pg.Pool({ connectionString: urlFor(database), max: 4 });
  await db.query("DROP TABLE IF EXISTS jobs, workers, tenants");
  await migrate(db);
  return db;
}

// Short timings so tests notice a crash in about a second.
const FAST_SETTINGS = {
  LEASE_MS: "1500",
  HEARTBEAT_MS: "300",
  BACKOFF_MS: "200",
  TICK_MS: "20",
  LOG_EVERY_MS: "3600000",
};

export function start(
  script: "api" | "scheduler" | "worker",
  settings: Record<string, string> = {},
): ChildProcess {
  const file = fileURLToPath(new URL(`../src/${script}.ts`, import.meta.url));
  return spawn(process.execPath, [file], {
    env: {
      ...process.env,
      ...FAST_SETTINGS,
      DATABASE_URL: testDatabaseUrl,
      ...settings,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** A TCP proxy, so a test can cut one process off from Postgres. */
export async function databaseProxy(databaseUrl = testDatabaseUrl) {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  // Frozen connections stay silent for good.
  const silent = new Set<Socket>();
  let down = false;
  let frozen = false;

  const forward = (from: Socket, to: Socket) => {
    sockets.add(from);
    if (frozen) silent.add(from);
    from.on("data", (chunk) => {
      if (!silent.has(from)) to.write(chunk);
    });
    from.on("error", () => {}); // a cut connection is what we are here for
    from.on("close", () => {
      sockets.delete(from);
      to.destroy();
    });
  };
  const server = createServer((client) => {
    if (down) return void client.destroy();
    const postgres = openSocket(Number(target.port || 5432), target.hostname);
    forward(client, postgres);
    forward(postgres, client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as AddressInfo).port);
  const dropConnections = () => sockets.forEach((socket) => socket.destroy());

  return {
    url: url.href,
    /** Like Postgres being down. */
    cut() {
      down = true;
      dropConnections();
    },
    /** Like Postgres hanging. */
    freeze() {
      frozen = true;
      sockets.forEach((socket) => silent.add(socket));
    },
    restore() {
      down = false;
      frozen = false;
    },
    close() {
      dropConnections();
      server.close();
    },
  };
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

export function jobIs(db: pg.Pool, id: string, status: string) {
  return async () => {
    const job = await getJob(db, id);
    return job.status === status ? job : undefined;
  };
}

/** Polls until the check returns a value, or fails after the timeout. */
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
