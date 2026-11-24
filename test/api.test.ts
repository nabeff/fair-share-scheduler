// The HTTP API, as a real process on a real Postgres.
// Needs the database from docker compose: docker compose up -d db

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
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
  const post = (body: string) =>
    fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  before(async () => {
    db = await freshDatabase(DATABASE);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start("api", {
      PORT: String(port),
      DATABASE_URL: urlFor(DATABASE),
    });
    await waitFor("the API to answer", async () => {
      try {
        return (await get("/health")).ok || undefined;
      } catch {
        return undefined; // not listening yet
      }
    });
  });
  after(async () => {
    api.kill("SIGKILL");
    await db.end();
  });

  test("a submitted job is stored and can be read back", async () => {
    const response = await post(
      JSON.stringify({ tenant_id: "small-1", payload: { sleep_ms: 100 } }),
    );
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.status, "pending");

    const job = await (await get(`/jobs/${created.id}`)).json();
    assert.equal(job.id, created.id);
    assert.equal(job.tenant_id, "small-1");
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
  });

  test("a job picked by the scheduler reads as pending until a worker starts it", async () => {
    const id = await submit(db, "small-1", {});
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
    const missingPayload = await post(JSON.stringify({ tenant_id: "small-1" }));
    assert.equal(missingPayload.status, 400);

    const notJson = await post("{not json");
    assert.equal(notJson.status, 400);

    // Valid JSON that Postgres cannot store in a jsonb column.
    const nulCharacter = await post(
      JSON.stringify({ tenant_id: "small-1", payload: { text: "\u0000" } }),
    );
    assert.equal(nulCharacter.status, 400);
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
