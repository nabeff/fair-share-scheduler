# Architecture

## The parts

```mermaid
flowchart LR
  client["Client or the live page"] -- "POST /jobs, GET /jobs/:id, GET /pool" --> api["API"]
  api -- "stores the job as pending" --> pg[("Postgres")]
  scheduler["Scheduler, a pass every 20 ms"] -- "marks the fair next jobs ready" --> pg
  workers["4 workers, 5 slots each"] -- "claim ready jobs, heartbeat, report" --> pg
```

The parts never call each other. They only read and write Postgres, which is the storage and the queue. Only the scheduler decides which tenant gets a free slot. A worker runs whatever is marked ready, oldest first.

## The life of a job

```mermaid
stateDiagram-v2
  direction LR
  [*] --> pending: POST /jobs
  pending --> ready: scheduler picks it
  ready --> running: a worker claims it
  running --> succeeded
  running --> failed: error
  failed --> ready: scheduler, after the backoff
  running --> pending: lease expired, or worker stopped
  running --> dead: out of attempts
  succeeded --> [*]
  dead --> [*]
```

A job gets 3 attempts, with a backoff of 2 s, then 4 s. A worker keeps a job only while its heartbeats renew the 10 s lease. If they stop, the scheduler puts the job back, so a job can run twice but is never lost. A result from a worker that lost its lease is ignored.

Why it works this way, and what it costs, is in [design.md](design.md).
