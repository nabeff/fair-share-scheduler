# Operations

How to run it day to day. Every command runs from the repo root.

## Start and stop

```bash
docker compose up --build -d   # start everything in the background
docker compose down            # stop, the jobs stay in Postgres
docker compose down -v         # stop and delete every job
```

## Add workers

```bash
docker compose up -d --scale worker=8
```

The pool grows from 20 to 40 slots as soon as the new workers send their first heartbeat. Nothing else needs to change. To shrink it, scale down: a stopped worker finishes what it can in 8 s, then hands the rest back without using an attempt.

## Change a weight or add a tenant

Edit `tenants.json`, then:

```bash
docker compose build migrate && docker compose run --rm migrate
```

The scheduler reads the weights on every pass, so the new split starts right away.

## Watch it

```bash
docker compose logs -f scheduler
# slots=20 running: supermarket=15+ cafe=5 (pass: 2.8 ms)
```

Every 5 s, if something changed: the live slots, the workers each tenant holds (`+` means it has more waiting), and how long a pass takes. The same picture is on the live page and in `GET /pool`.

```bash
docker compose exec db psql -U postgres scheduler \
  -c "SELECT status, count(*) FROM jobs GROUP BY status"
```

## When something breaks

| What                       | What happens                                                                                     | What to do                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| A worker crashes           | Its jobs go back to the queue after the 10 s lease, and count an attempt.                        | Nothing. Docker restarts a crashed process.                |
| The scheduler stops        | Running jobs finish. New jobs wait.                                                              | Nothing. Docker restarts it, and it picks up where it was. |
| Postgres is down           | The API answers 503. The scheduler and workers retry every second, and carry on once it is back. | Bring Postgres back. A job may run twice, none is lost.    |
| A job is `dead`            | It used all 3 attempts. `last_error` says why.                                                   | Fix the cause, then run it again (below).                  |
| Many `lease was lost` logs | Workers are too slow to send their heartbeat, so jobs run twice.                                 | Give the workers more CPU, or raise `LEASE_MS`.            |

To run a dead job again:

```sql
UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL
WHERE id = 42 AND status = 'dead';
```

## Settings

Environment variables. Set them under `environment` in `docker-compose.yml`. A bad value stops the service at start, with the name of the variable.

| Variable            | Default | What it does                                    |
| ------------------- | ------- | ----------------------------------------------- |
| `WORKER_SLOTS`      | 5       | Jobs one worker process runs at once.           |
| `LEASE_MS`          | 10000   | Silence after which a worker counts as dead.    |
| `HEARTBEAT_MS`      | 2000    | How often a worker says it is alive.            |
| `MAX_ATTEMPTS`      | 3       | Attempts before a job is dead.                  |
| `BACKOFF_MS`        | 2000    | Wait before the first retry, doubled each time. |
| `SHUTDOWN_GRACE_MS` | 8000    | Time a stopping worker gets to finish its jobs. |
| `TICK_MS`           | 20      | Pause between two scheduler passes.             |
| `POLL_MS`           | 20      | How often a free worker looks for a job.        |
| `DB_TIMEOUT_MS`     | 5000    | Time limit on every Postgres call.              |
| `LOG_EVERY_MS`      | 5000    | How often the scheduler logs.                   |

Keep `LEASE_MS` several times `HEARTBEAT_MS`, or a slow heartbeat looks like a crash.
