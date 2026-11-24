// Every setting comes from the environment, so one image can run as API, scheduler or worker.

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/scheduler",

  // Tenants and weights are seeded from this file on every start.
  tenantsFile:
    process.env.TENANTS_FILE ??
    new URL("../tenants.json", import.meta.url).pathname,
};
