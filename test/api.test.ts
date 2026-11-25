// The HTTP API, as a real process on a real Postgres.
// Needs the database from docker compose: docker compose up -d db

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
  databaseProxy,
  freshDatabase,
  postgresIsUp,
  start,
  submit,
  urlFor,
  waitFor,
} from "./helpers.ts";

const skip = (await postgresIsUp())
  ? false
  : "Postgres is not reachable. Start it with: docker compose up -d db";

// A database of its own: this file runs at the same time as the crash tests.
const DATABASE = "scheduler_test_api";

describe("the API", { skip }, () => {
  let db: pg.Pool;
  let api: ChildProcess;
  let base: string;

  const get = (path: string) => fetch(base + path);
  const post = (body: string, to = base) =>
    fetch(`${to}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000), // an answer that never comes fails the test
    });

  /** Starts an API process on a free port and waits until it answers. */
  async function startApi(settings: Record<string, string>) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const process = start("api", { PORT: String(port), ...settings });
    await waitFor("the API to answer", async () => {
      try {
        return (await fetch(`${url}/health`)).ok || undefined;
      } catch {
        return undefined; // not listening yet
      }
    });
    return { process, url };
  }

  before(async () => {
    db = await freshDatabase(DATABASE);
    const started = await startApi({ DATABASE_URL: urlFor(DATABASE) });
    api = started.process;
    base = started.url;
  });
  after(async () => {
    api.kill("SIGKILL");
    await db.end();
  });

  test("a submitted job is stored and can be read back", async () => {
    const response = await post(
      JSON.stringify({ tenant_id: "cafe", payload: { sleep_ms: 100 } }),
    );
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.status, "pending");

    const job = await (await get(`/jobs/${created.id}`)).json();
    assert.equal(job.id, created.id);
    assert.equal(job.tenant_id, "cafe");
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
  });

  test("a job picked by the scheduler reads as pending until a worker starts it", async () => {
    const id = await submit(db, "cafe", {});
    await db.query("UPDATE jobs SET status = 'ready' WHERE id = $1", [id]);

    const job = await (await get(`/jobs/${id}`)).json();
    assert.equal(job.status, "pending");
  });

  test("an unknown tenant gets 404", async () => {
    const response = await post(
      JSON.stringify({ tenant_id: "nobody", payload: {} }),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "unknown tenant: nobody",
    });
  });

  test("an unknown job gets 404", async () => {
    assert.equal((await get("/jobs/999999")).status, 404);
    assert.equal((await get("/jobs/not-a-number")).status, 404);
  });

  // 503 tells the client to retry. A request that can never work must not get it.
  test("a request that can never work gets 400, not 503", async () => {
    const missingPayload = await post(JSON.stringify({ tenant_id: "cafe" }));
    assert.equal(missingPayload.status, 400);

    const notJson = await post("{not json");
    assert.equal(notJson.status, 400);

    // Valid JSON that Postgres cannot store in a jsonb column.
    const nulCharacter = await post(
      JSON.stringify({ tenant_id: "cafe", payload: { text: "\u0000" } }),
    );
    assert.equal(nulCharacter.status, 400);
  });

  // Not asked for by the brief: the numbers behind the live page in web/.
  test("the pool shows who holds the workers and who waits", async () => {
    // A case of its own, with nothing left from the tests above.
    await db.query("TRUNCATE jobs");
    await db.query("DELETE FROM workers");
    await db.query(
      `INSERT INTO workers (id, slots, last_seen) VALUES
         ('alive-1', 5, now()), ('alive-2', 5, now()),
         ('silent', 5, now() - interval '1 hour')`,
    );
    await db.query(
      `INSERT INTO jobs (tenant_id, payload, status) VALUES
         ('bank', '{}', 'running'), ('bank', '{}', 'running'),
         ('bank', '{}', 'pending'), ('bank', '{}', 'ready'),
         ('bank', '{}', 'failed'),
         ('bank', '{}', 'succeeded'), ('bank', '{}', 'dead')`,
    );

    const pool = await (await get("/pool")).json();
    const tenant = (id: string) =>
      pool.tenants.find((t: { id: string }) => t.id === id);

    assert.equal(pool.slots, 10); // the silent worker is not part of the pool
    assert.deepEqual(tenant("bank"), {
      id: "bank",
      weight: 4,
      running: 2,
      waiting: 3, // not started yet, or waiting for a retry
    });
    assert.deepEqual(tenant("cafe"), {
      id: "cafe",
      weight: 1,
      running: 0,
      waiting: 0,
    });
  });

  // Postgres takes the connection but never answers: a frozen server, or a
  // network that swallows the packets. The client must not be left waiting.
  test("when Postgres stops answering, the API says 503 instead of waiting", async () => {
    const postgres = await databaseProxy(urlFor(DATABASE));
    const second = await startApi({
      DATABASE_URL: postgres.url,
      DB_TIMEOUT_MS: "300",
    });
    const job = JSON.stringify({ tenant_id: "cafe", payload: {} });
    try {
      assert.equal((await post(job, second.url)).status, 201);

      postgres.freeze();
      assert.equal((await post(job, second.url)).status, 503);

      postgres.restore();
      await waitFor("jobs to be stored again", async () =>
        (await post(job, second.url)).status === 201 ? true : undefined,
      );
    } finally {
      second.process.kill("SIGKILL");
      postgres.close();
    }
  });
});

/** A port nobody uses: ask the system for one, then give it back. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
