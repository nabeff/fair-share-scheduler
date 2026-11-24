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

  // Retries: a job is started at most this many times, then it is dead.
  maxAttempts: number("MAX_ATTEMPTS", 3),
};
