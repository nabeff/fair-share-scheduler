// HTTP API: submit a job and read its status.
// Stateless. A job is accepted once its row is committed in Postgres.

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
      // Opaque to the API and the scheduler. Only the worker reads it.
      payload: { type: "object" },
    },
  },
};

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
  // "ready" is an internal step between the scheduler and a worker.
  const status = job.status === "ready" ? "pending" : job.status;
  return { ...job, status };
});

app.get("/health", async () => {
  await db.query("SELECT 1");
  return { ok: true };
});

// A mistake of the client (bad JSON, a missing field, a body that is too
// large) keeps its 4xx status. Anything else means we could not store or read
// the job: 503, so the client retries. We never answer 201 for a job that is
// not safely in Postgres.
app.setErrorHandler(
  (err: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    // Postgres class 22, a data error: the payload is valid JSON that a jsonb
    // column cannot store (a NUL character). A retry would never help.
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
