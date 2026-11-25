# API

JSON over HTTP, on port 8080. Errors always come back as `{"error": "..."}`.

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 400  | The request can never work (missing field, bad payload). |
| 404  | Unknown tenant or job.                                   |
| 503  | Postgres did not answer in time. Retry.                  |

## POST /jobs

Stores a job. Answers only once the job is committed in Postgres.

```json
{ "tenant_id": "cafe", "payload": { "sleep_ms": 200 } }
```

`payload` must be an object. The scheduler never reads it, only the worker does: `sleep_ms` is how long the job sleeps, and `fail_attempts: N` makes its first N attempts fail.

**201**

```json
{ "id": "1", "status": "pending" }
```

The id is a string, because it can grow past what a JavaScript number holds. There is no idempotency key yet: if the reply is lost and the client sends the job again, it is stored twice.

## GET /jobs/:id

**200**

```json
{
  "id": "1",
  "tenant_id": "cafe",
  "status": "succeeded",
  "attempts": 1,
  "max_attempts": 3,
  "created_at": "2026-11-24T15:40:01.120Z",
  "started_at": "2026-11-24T15:40:01.384Z",
  "finished_at": "2026-11-24T15:40:01.590Z",
  "run_at": "2026-11-24T15:40:01.120Z",
  "last_error": null
}
```

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `pending`   | Waiting for a worker.                                  |
| `running`   | A worker has it. `attempts` counts this attempt.       |
| `failed`    | The last attempt failed. It runs again after `run_at`. |
| `succeeded` | Done.                                                  |
| `dead`      | Out of attempts. `last_error` says why.                |

## GET /pool

What the live page draws: the workers alive now, and the jobs of every tenant.

```json
{
  "slots": 20,
  "tenants": [{ "id": "bank", "weight": 4, "running": 8, "waiting": 412 }]
}
```

`slots` counts workers that sent a heartbeat within one lease. `waiting` is every job of the tenant that is not running yet.

## GET /health

**200** `{"ok": true}` when the API can reach Postgres, **503** when it can't.
