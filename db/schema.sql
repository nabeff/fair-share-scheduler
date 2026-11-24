-- Schema for the fair share scheduler. Safe to run again on every start.

-- Tenants and their plan weight.
CREATE TABLE IF NOT EXISTS tenants (
  id     text PRIMARY KEY,
  weight integer NOT NULL CHECK (weight > 0),
  -- Virtual time: worker seconds this tenant has used, divided by its weight.
  -- The scheduler serves the tenant with the lowest value first.
  vtime  double precision NOT NULL DEFAULT 0,
  -- True while the tenant has waiting or running jobs. Only the scheduler writes it.
  active boolean NOT NULL DEFAULT false
);

-- One row per job. This table is also the queue.
--
--   pending    waiting for the scheduler
--   ready      picked by the scheduler, waiting for a worker to claim it (the API reports it as pending)
--   running    a worker holds it under a lease
--   succeeded  done
--   failed     the last attempt threw an error, a retry is scheduled at run_at
--   dead       gave up after max_attempts
CREATE TABLE IF NOT EXISTS jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (id),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  run_at           timestamptz NOT NULL DEFAULT now(),  -- do not start before this time (retry backoff)
  worker_id        text,                                -- worker that holds or last ran the job
  lease_expires_at timestamptz,                         -- pushed forward by worker heartbeats
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  started_at       timestamptz,                         -- start of the latest attempt
  finished_at      timestamptz
);

-- Waiting jobs per tenant, oldest first. The scheduler only reads the head of each tenant's
-- queue, so its cost does not grow with the size of the backlog.
CREATE INDEX IF NOT EXISTS jobs_waiting ON jobs (tenant_id, run_at, id)
  WHERE status IN ('pending', 'failed');

-- The ready queue that workers claim from.
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (ready_at, id)
  WHERE status = 'ready';

-- Jobs that hold a worker slot. Never more rows than there are slots, so it stays tiny.
CREATE INDEX IF NOT EXISTS jobs_in_flight ON jobs (tenant_id)
  WHERE status IN ('ready', 'running');

-- A queue table churns: every job row is updated three times. Vacuum early to keep the
-- indexes above small.
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000);

-- Worker registry. The scheduler sums the slots of live workers to know the pool size.
CREATE TABLE IF NOT EXISTS workers (
  id        text PRIMARY KEY,
  slots     integer NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now()
);
