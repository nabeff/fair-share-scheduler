-- Safe to run on every start.

CREATE TABLE IF NOT EXISTS tenants (
  id     text PRIMARY KEY,
  weight integer NOT NULL CHECK (weight > 0),
  -- Worker seconds used / weight. Lowest goes first.
  vtime  double precision NOT NULL DEFAULT 0,
  -- Has waiting or running jobs. Written by the scheduler only.
  active boolean NOT NULL DEFAULT false
);

-- This table is also the queue.
-- pending -> ready (picked by the scheduler) -> running -> succeeded
-- failed: waiting for a retry at run_at. dead: out of attempts.
CREATE TABLE IF NOT EXISTS jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants (id),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  run_at           timestamptz NOT NULL DEFAULT now(),  -- retry backoff
  worker_id        text,                                -- last worker to run it
  lease_expires_at timestamptz,                         -- renewed by heartbeats
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  started_at       timestamptz,                         -- latest attempt
  finished_at      timestamptz
);

-- Oldest waiting jobs per tenant. The scheduler reads only the head of it,
-- so a pass costs the same whatever the backlog.
CREATE INDEX IF NOT EXISTS jobs_waiting ON jobs (tenant_id, created_at, id)
  WHERE status IN ('pending', 'failed');

-- What workers claim from.
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (ready_at, id)
  WHERE status = 'ready';

-- Jobs holding a slot. Tiny: never more than the pool.
CREATE INDEX IF NOT EXISTS jobs_in_flight ON jobs (tenant_id)
  WHERE status IN ('ready', 'running');

-- Every job row is updated 3 times, so vacuum early.
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000);

-- Live workers and their slots make up the pool.
CREATE TABLE IF NOT EXISTS workers (
  id        text PRIMARY KEY,
  slots     integer NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now()
);
