// HTTP API: submit a job, read its status. A job counts as accepted once
// it is committed in Postgres.

import Fastify from "fastify";
import { config } from "./config.ts";
import { connect } from "./db.ts";

const FOREIGN_KEY_VIOLATION = "23503";

const db = connect(20);
const app = Fastify();

interface SubmitBody {
  tenant_id: string;
  payload: Record<string, unknown>;
}

const submitSchema = {
  body: {
    type: "object",
    required: ["tenant_id", "payload"],
    properties: {
      tenant_id: { type: "string", minLength: 1 },
      // Only the worker reads this.
      payload: { type: "object" },
    },
  },
};

// POST /jobs: store a new job for a tenant and return its id.
app.post<{ Body: SubmitBody }>(
  "/jobs",
  { schema: submitSchema },
  async (request, reply) => {
    const { tenant_id, payload } = request.body;
    try {
      const { rows } = await db.query(
        `INSERT INTO jobs (tenant_id, payload, max_attempts)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [tenant_id, payload, config.maxAttempts],
      );
      return reply.code(201).send({ id: rows[0].id, status: "pending" });
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        return reply.code(404).send({ error: `unknown tenant: ${tenant_id}` });
      }
      throw err;
    }
  },
);

// GET /jobs/:id: return the status of one job.
app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
  const { id } = request.params;
  if (!/^\d{1,18}$/.test(id)) {
    return reply.code(404).send({ error: "job not found" });
  }
  const { rows } = await db.query(
    `SELECT id, tenant_id, status, attempts, max_attempts,
            created_at, started_at, finished_at, run_at, last_error
     FROM jobs WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    return reply.code(404).send({ error: "job not found" });
  }
  const job = rows[0];
  // "ready" is internal, clients see it as pending.
  const status = job.status === "ready" ? "pending" : job.status;
  return { ...job, status };
});

// GET /health: answers ok when the API can reach Postgres.
app.get("/health", async () => {
  await db.query("SELECT 1");
  return { ok: true };
});

// GET /pool: workers and jobs per tenant, for the live page. Lists every
// tenant, fine for 8, not for 5,000 (then: only tenants with work, paginated).
app.get("/pool", async () => {
  // Same count as the scheduler: workers seen within one lease.
  const workers = await db.query(
    `SELECT coalesce(sum(slots), 0)::int AS slots
     FROM workers
     WHERE last_seen > now() - $1::int * interval '1 ms'`,
    [config.leaseMs],
  );
  const tenants = await db.query(
    `SELECT t.id, t.weight,
            coalesce(held.running, 0)::int AS running,
            (coalesce(held.ready, 0) + coalesce(queued.waiting, 0))::int AS waiting
     FROM tenants t
     LEFT JOIN (
       SELECT tenant_id,
              count(*) FILTER (WHERE status = 'running') AS running,
              count(*) FILTER (WHERE status = 'ready') AS ready
       FROM jobs
       WHERE status IN ('ready', 'running')
       GROUP BY tenant_id
     ) held ON held.tenant_id = t.id
     LEFT JOIN (
       SELECT tenant_id, count(*) AS waiting
       FROM jobs
       WHERE status IN ('pending', 'failed')
       GROUP BY tenant_id
     ) queued ON queued.tenant_id = t.id
     ORDER BY t.id`,
  );
  return { slots: workers.rows[0].slots, tenants: tenants.rows };
});

// Client mistakes keep their 4xx. Anything else is a 503 so the client
// retries. Never 201 unless the job is safely stored.
app.setErrorHandler(
  (err: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    // Class 22: valid JSON that jsonb can't store (a NUL character).
    if (err.code?.startsWith("22")) {
      return reply.code(400).send({ error: "payload cannot be stored" });
    }
    console.error("request failed:", err.message);
    return reply.code(503).send({ error: "temporarily unavailable, retry" });
  },
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`api listening on port ${config.port}`);
