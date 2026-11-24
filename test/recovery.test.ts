// Crash recovery and retries, on a real Postgres with real processes.
// Needs the database from docker compose: docker compose up -d db

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { after, afterEach, before, describe, test } from "node:test";
import type pg from "pg";
import { pass } from "../src/scheduler.ts";
import {
  freshDatabase,
  getJob,
  jobIs,
  postgresIsUp,
  start,
  submit,
  waitFor,
} from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

describe("a lease that expired", { skip }, () => {
  let db: pg.Pool;
  before(async () => {
    db = await freshDatabase();
  });
  after(() => db.end());

  // A job as a dead worker would leave it: running, nobody extending it.
  async function abandonedJob(attempts: number, leaseEndsInSeconds: number) {
    const { rows } = await db.query(
      `INSERT INTO jobs (tenant_id, payload, status, attempts, worker_id,
                         started_at, lease_expires_at)
       VALUES ('small-1', '{}', 'running', $1, 'worker-that-died',
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
    const { rows } = await db.query(
      "SELECT vtime FROM tenants WHERE id = 'small-1'",
    );
    // 30 seconds on a tenant of weight 1.
    assert.ok(rows[0].vtime >= 30 && rows[0].vtime < 31, `${rows[0].vtime}`);
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
  // Every test starts its own workers and leaves none behind.
  afterEach(() => {
    for (const worker of workers.splice(0)) worker.kill("SIGKILL");
  });
  after(async () => {
    scheduler.kill("SIGKILL");
    await db.end();
  });

  test("a job is retried when its worker is killed in the middle", async () => {
    const first = startWorker();
    const id = await submit(db, "small-1", { sleep_ms: 1500 });
    const started = await waitFor("the job to start", jobIs(db, id, "running"));

    first.kill("SIGKILL"); // a crash: no cleanup, no goodbye
    startWorker();

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.notEqual(done.worker_id, started.worker_id);
    assert.match(done.last_error, /lease expired/);
  });

  // What Docker does after a crash: the container restarts and the worker
  // comes back under the same id. It must not keep its old job alive.
  test("the job is also retried when the worker restarts under the same id", async () => {
    const first = startWorker({ WORKER_ID: "worker-a" });
    const id = await submit(db, "small-1", { sleep_ms: 1500 });
    await waitFor("the job to start", jobIs(db, id, "running"));

    first.kill("SIGKILL");
    startWorker({ WORKER_ID: "worker-a" });

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.equal(done.worker_id, "worker-a");
    assert.match(done.last_error, /lease expired/);
  });

  test("a job that fails once succeeds on the retry", async () => {
    startWorker();
    const id = await submit(db, "small-1", { fail_attempts: 1 });

    const done = await waitFor("the retry", jobIs(db, id, "succeeded"));
    assert.equal(done.attempts, 2);
    assert.equal(done.last_error, "simulated failure on attempt 1");
  });

  test("a job that always fails is dead after 3 attempts", async () => {
    startWorker();
    const id = await submit(db, "small-1", { fail_attempts: 99 });

    const dead = await waitFor("the job to die", jobIs(db, id, "dead"));
    assert.equal(dead.attempts, 3);
    assert.equal(dead.last_error, "simulated failure on attempt 3");
    assert.ok(dead.finished_at);
  });
});
