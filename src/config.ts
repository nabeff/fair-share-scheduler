// Every setting comes from the environment, so one image can run as API,
// scheduler or worker.

const number = (name: string, fallback: number): number =>
  Number(process.env[name] ?? fallback);

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/scheduler",

  // Tenants and weights are seeded from this file on every start.
  tenantsFile:
    process.env.TENANTS_FILE ??
    new URL("../tenants.json", import.meta.url).pathname,

  // API
  port: number("PORT", 8080),

  // Worker
  workerSlots: number("WORKER_SLOTS", 5), // jobs one process runs at once
  pollMs: number("POLL_MS", 20), // how often a free worker looks for a job
  heartbeatMs: number("HEARTBEAT_MS", 2000),
  shutdownGraceMs: number("SHUTDOWN_GRACE_MS", 8000),

  // A job goes back to the queue when its worker is silent for this long.
  // Five missed heartbeats with the defaults.
  leaseMs: number("LEASE_MS", 10_000),

  // Retries: a job is started at most this many times, then it is dead.
  maxAttempts: number("MAX_ATTEMPTS", 3),
  // Wait before a retry: 2 s after the first failure, then 4 s, 8 s ...
  backoffMs: number("BACKOFF_MS", 2000),
};
