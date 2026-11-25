// All settings come from env vars, so one image runs every service.

import { fileURLToPath } from "node:url";

// Fail at startup on a bad value, instead of running with NaN.
const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a whole number of 0 or more, got "${raw}"`,
    );
  }
  return value;
};

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:54329/scheduler",

  // Timeout for every Postgres call.
  dbTimeoutMs: number("DB_TIMEOUT_MS", 5000),

  tenantsFile:
    process.env.TENANTS_FILE ??
    fileURLToPath(new URL("../tenants.json", import.meta.url)),

  // API
  port: number("PORT", 8080),

  // Scheduler
  tickMs: number("TICK_MS", 20), // pause between two passes
  logEveryMs: number("LOG_EVERY_MS", 5000),

  // Worker
  workerSlots: number("WORKER_SLOTS", 5), // jobs one process runs at once
  pollMs: number("POLL_MS", 20), // how often a free worker looks for a job
  heartbeatMs: number("HEARTBEAT_MS", 2000),
  shutdownGraceMs: number("SHUTDOWN_GRACE_MS", 8000),

  // Silent this long = worker is dead (5 missed heartbeats).
  leaseMs: number("LEASE_MS", 10_000),

  maxAttempts: number("MAX_ATTEMPTS", 3),
  // Retry backoff: 2 s, 4 s, 8 s ...
  backoffMs: number("BACKOFF_MS", 2000),
};
