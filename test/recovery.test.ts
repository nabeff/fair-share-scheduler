// Crash recovery and retries with real processes. Needs: docker compose up -d db

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import type pg from "pg";
import { sleep } from "../src/db.ts";
import { pass } from "../src/scheduler.ts";
import {
  databaseProxy,
  freshDatabase,
  getJob,
  jobIs,
  postgresIsUp,
  start,
  submit,
  testDatabaseUrl,
  waitFor,
} from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

async function vtimeOf(db: pg.Pool, tenantId: string): Promise<number> {
  const { rows } = await db.query("SELECT vtime FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  return rows[0].vtime;
}

describe("a lease that expired", { skip }, () => {
  let db: pg.Pool;
  before(async () => {
    db = await freshDatabase();
  });
  after(() => db.end());

  // A job left behind by a dead worker.
  async function abandonedJob(attempts: number, leaseEndsInSeconds: number) {
    const { rows } = await db.query(
      `INSERT INTO jobs (tenant_id, payload, status, attempts, worker_id,
                         started_at, lease_expires_at)
       VALUES ('cafe', '{}', 'running', $1, 'worker-that-died',
               now() - interval '30 seconds',
               now() + $2::int * interval '1 second')
       RETURNING id`,
      [attempts, leaseEndsInSeconds],
    );
    return rows[0].id as string;
  }

  test("the job goes back to the queue, the attempt stays counted", async () => {
    const id = await abandonedJob(1, -1);
    await pass(db);

    const job = await getJob(db, id);
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 1);
    assert.match(job.last_error, /lease expired/);
  });

  test("the tenant is charged for the time the job held a worker", async () => {
    const usedBefore = await vtimeOf(db, "cafe");
    await abandonedJob(1, -1);
    await pass(db);

    const charged = (await vtimeOf(db, "cafe")) - usedBefore;
    assert.ok(charged >= 30 && charged < 31, `${charged}`);
  });

  test("a job whose lease is still valid is left alone", async () => {
    const id = await abandonedJob(1, +60);
    await pass(db);
    assert.equal((await getJob(db, id)).status, "running");
  });

  test("on its last attempt the job is dead, it does not loop", async () => {
    const id = await abandonedJob(3, -1);
    await pass(db);

    const job = await getJob(db, id);
    assert.equal(job.status, "dead");
    assert.ok(job.finished_at);
  });

  test("a pass that is told not to judge leases leaves the job alone", async () => {
    const id = await abandonedJob(1, -1);
    await pass(db, false);
    assert.equal((await getJob(db, id)).status, "running");

    await pass(db);
    assert.equal((await getJob(db, id)).status, "pending");
  });
});

// A scheduler frozen mid-pass must not keep the lock forever.
describe("a scheduler that froze in the middle of a pass", { skip }, () => {
  let db: pg.Pool;
  before(async () => {
    db = await freshDatabase();
  });
  after(() => db.end());

  const takeTheLockAndGoSilent = `
    const { connect } = await import(process.argv[1]);
    const { SCHEDULER_LOCK } = await import(process.argv[2]);
    const tx = await connect(1).connect();
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SCHEDULER_LOCK]);`;

  test("Postgres ends its transaction, the next pass gets the lock", async () => {
    const frozen = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        takeTheLockAndGoSilent,
        new URL("../src/db.ts", import.meta.url).href,
        new URL("../src/scheduler.ts", import.meta.url).href,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: testDatabaseUrl,
          DB_TIMEOUT_MS: "1000",
        },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    try {
      await waitFor("the lock to be taken", async () =>
        (await pass(db)) === null ? true : undefined,
      );
      await waitFor(
        "the lock to be free again",
        async () => (await pass(db)) ?? undefined,
        5000,
      );
    } finally {
      frozen.kill("SIGKILL");
    }
  });
});

describe("with a real scheduler and real workers", { skip }, () => {
  let db: pg.Pool;
  let scheduler: ChildProcess;
  const workers: ChildProcess[] = [];
  const startWorker = (settings?: Record<string, string>) => {
    const worker = start("worker", settings);
    workers.push(worker);
    return worker;
  };
  before(async () => {
    db = await freshDatabase();
    scheduler = start("scheduler");
  });
  afterEach(() => {
    for (const worker of workers.splice(0)) worker.kill("SIGKILL");
  });
  after(async () => {
    scheduler.kill("SIGKILL");
    await db.end();
  });

  test("a job is retried when its worker is killed in the middle", async () => {
    const first = startWorker();
    const id = await submit(db, "cafe", { sleep_ms: 1500 });
    const started = await waitFor("the job to start", jobIs(db, id, "running"));

    first.kill("SIGKILL"); // a crash: no cleanup, no goodbye
    startWorker();

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.notEqual(done.worker_id, started.worker_id);
    assert.match(done.last_error, /lease expired/);
  });

  // Docker restarts it under the same id. It must not keep its old job alive.
  test("the job is also retried when the worker restarts under the same id", async () => {
    const first = startWorker({ WORKER_ID: "worker-a" });
    const id = await submit(db, "cafe", { sleep_ms: 1500 });
    await waitFor("the job to start", jobIs(db, id, "running"));

    first.kill("SIGKILL");
    startWorker({ WORKER_ID: "worker-a" });

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.equal(done.worker_id, "worker-a");
    assert.match(done.last_error, /lease expired/);
  });

  // A deploy, not a crash.
  test("a worker that is stopped hands its job back, no attempt is used", async () => {
    const first = startWorker({ SHUTDOWN_GRACE_MS: "100" });
    const id = await submit(db, "kiosk", { sleep_ms: 1500 });
    await waitFor("the job to start", jobIs(db, id, "running"));
    const usedBefore = await vtimeOf(db, "kiosk");

    first.kill("SIGTERM");
    const back = await waitFor("the job to come back", async () => {
      const job = await getJob(db, id);
      return job.status === "running" ? undefined : job;
    });
    assert.equal(back.attempts, 0);
    assert.match(back.last_error, /handed back/);
    // The tenant still pays for the time used.
    const used = await vtimeOf(db, "kiosk");
    assert.ok(used > usedBefore, `${used} after, ${usedBefore} before`);

    startWorker();
    const done = await waitFor("the second run", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 1);
  });

  // A 6 s outage, shorter than the lease: the result is saved afterwards.
  test("a finished job is not run again because Postgres was away", async () => {
    const postgres = await databaseProxy();
    try {
      startWorker({ DATABASE_URL: postgres.url, LEASE_MS: "10000" });
      const id = await submit(db, "barber", { sleep_ms: 300 });
      await waitFor("the job to start", jobIs(db, id, "running"));

      postgres.cut();
      await sleep(6000);
      postgres.restore();

      const done = await waitFor("the result", jobIs(db, id, "succeeded"));
      assert.equal(done.attempts, 1);
    } finally {
      postgres.close();
    }
  });

  // The outage outlasts the lease and the job moved to another worker.
  test("a result that arrives after the lease was lost is refused", async () => {
    const postgres = await databaseProxy();
    try {
      startWorker({ DATABASE_URL: postgres.url, WORKER_ID: "cut-off" });
      const id = await submit(db, "barber", { sleep_ms: 300 });
      await waitFor("the job to start", jobIs(db, id, "running"));

      postgres.cut();
      startWorker({ WORKER_ID: "other" });
      const done = await waitFor("the second run", jobIs(db, id, "succeeded"));
      assert.equal(done.attempts, 2);
      assert.equal(done.worker_id, "other");

      postgres.restore();
      await sleep(1500); // the first worker offers its result every second
      assert.deepEqual(await getJob(db, id), done);
    } finally {
      postgres.close();
    }
  });

  // Postgres rejects the result (backoff too big for an int). The lease
  // runs out and the job is retried.
  test("a result that Postgres refuses is given up, not offered for ever", async () => {
    const worker = startWorker({ BACKOFF_MS: "3000000000" });
    const id = await submit(db, "florist", { fail_attempts: 1 });

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.match(done.last_error, /lease expired/);

    // It gave up on that result, so it stops right away.
    worker.kill("SIGTERM");
    await waitFor(
      "the worker to stop",
      async () => (worker.exitCode === null ? undefined : true),
      3000,
    );
  });

  test("a job that fails once succeeds on the retry", async () => {
    startWorker();
    const id = await submit(db, "cafe", { fail_attempts: 1 });

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.equal(done.last_error, "simulated failure on attempt 1");
  });

  test("a job that always fails is dead after 3 attempts", async () => {
    startWorker();
    const id = await submit(db, "cafe", { fail_attempts: 99 });

    const dead = await waitFor("the job to die", jobIs(db, id, "dead"));
    assert.equal(dead.attempts, 3);
    assert.equal(dead.last_error, "simulated failure on attempt 3");
    assert.ok(dead.finished_at);
  });
});

describe("when Postgres is away for everyone", { skip }, () => {
  let db: pg.Pool;
  let postgres: Awaited<ReturnType<typeof databaseProxy>>;
  const processes: ChildProcess[] = [];
  const startSchedulerAndWorker = (settings: Record<string, string>) => {
    for (const script of ["scheduler", "worker"] as const) {
      processes.push(
        start(script, { DATABASE_URL: postgres.url, ...settings }),
      );
    }
  };
  before(async () => {
    db = await freshDatabase();
  });
  beforeEach(async () => {
    postgres = await databaseProxy();
  });
  afterEach(() => {
    for (const process of processes.splice(0)) process.kill("SIGKILL");
    postgres.close();
  });
  after(() => db.end());

  // Without timeouts, a process would hang on the frozen connections forever.
  test("scheduler and worker carry on once it answers again", async () => {
    startSchedulerAndWorker({ DB_TIMEOUT_MS: "300" });
    const first = await submit(db, "cafe", {});
    await waitFor("a job before", jobIs(db, first, "succeeded"));

    postgres.freeze();
    await sleep(1000);
    postgres.restore();

    const second = await submit(db, "cafe", {});
    await waitFor("a job after", jobIs(db, second, "succeeded"));
  });

  // Every lease expired during the outage, but the worker is alive.
  test("an outage is not taken for a crash of every worker", async () => {
    startSchedulerAndWorker({ LEASE_MS: "4000" });
    const id = await submit(db, "cafe", { sleep_ms: 300 });
    await waitFor("the job to start", jobIs(db, id, "running"));

    postgres.cut();
    await sleep(5000);
    postgres.restore();

    const done = await waitFor("the result", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 1);
  });
});
