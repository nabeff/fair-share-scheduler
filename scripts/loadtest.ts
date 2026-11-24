// Load test: shows with real numbers that the scheduler is fair.
//
//   node scripts/loadtest.ts flood     one tenant floods, four small ones arrive
//   node scripts/loadtest.ts weights   three tenants with weights 1, 2 and 4
//   node scripts/loadtest.ts           both
//
// Jobs are submitted through the HTTP API, like a client would. The results
// are measured from the job timestamps in Postgres, then printed and written
// to results/ as CSV and text.

import { mkdir, writeFile } from "node:fs/promises";
import { connect, sleep } from "../src/db.ts";

const API_URL = process.env.API_URL ?? "http://localhost:8080";
const RESULTS_DIR = process.env.RESULTS_DIR ?? "results";
const FLOOD_JOBS = Number(process.env.FLOOD_JOBS ?? 100_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const BUCKET_SECONDS = 5;

const db = connect(4);

// ---------------------------------------------------------------- helpers

const between = (min: number, max: number) => () =>
  Math.round(min + Math.random() * (max - min));

async function submit(tenant: string, sleepMs: number): Promise<void> {
  const response = await fetch(`${API_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: tenant, payload: { sleep_ms: sleepMs } }),
  });
  if (response.status !== 201) {
    throw new Error(
      `submit failed: ${response.status} ${await response.text()}`,
    );
  }
}

/** Submits `count` jobs for a tenant and returns the rate in jobs per second. */
async function submitMany(
  tenant: string,
  count: number,
  sleepMs: () => number,
): Promise<number> {
  const startedAt = Date.now();
  let next = 0;
  const client = async () => {
    while (next < count) {
      next += 1;
      await submit(tenant, sleepMs());
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, client));
  return count / ((Date.now() - startedAt) / 1000);
}

/** The clock of the database, the one the job timestamps come from. */
async function dbNow(): Promise<Date> {
  return (await db.query("SELECT now() AS now")).rows[0].now;
}

async function poolSize(): Promise<number> {
  const { rows } = await db.query(
    `SELECT coalesce(sum(slots), 0)::int AS slots FROM workers
     WHERE last_seen > now() - interval '10 seconds'`,
  );
  return rows[0].slots;
}

/** Waits until the API answers and workers have registered. */
async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const health = await fetch(`${API_URL}/health`);
      if (health.ok && (await poolSize()) > 0) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error("the system is not up. Start it: docker compose up -d");
    }
    await sleep(500);
  }
}

/** Empties the queue and forgets past usage, so every run starts equal. */
async function reset(): Promise<void> {
  await db.query("TRUNCATE jobs RESTART IDENTITY");
  await db.query("UPDATE tenants SET vtime = 0, active = false");
  await sleep(3500); // let the workers finish what they were holding
  await db.query("UPDATE tenants SET vtime = 0, active = false");
}

/** "45 seconds" or "23 minutes". */
const duration = (s: number) =>
  s < 120 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`;

const seconds = (from: Date, to: Date) =>
  (to.getTime() - from.getTime()) / 1000;
const addSeconds = (date: Date, s: number) =>
  new Date(date.getTime() + s * 1000);

// ------------------------------------------------------------ measurement

interface Bucket {
  /** Start of the bucket, in seconds relative to the reference time. */
  start: number;
  /** Worker seconds used in the bucket, per tenant. */
  used: Map<string, number>;
}

/**
 * Who held the workers over time. Each job counts for the time it really
 * ran, split over the buckets it overlaps.
 */
async function workerTime(
  from: Date,
  to: Date,
  bucketSeconds: number,
  reference = from,
): Promise<Bucket[]> {
  const { rows } = await db.query(
    `SELECT tenant_id, started_at, coalesce(finished_at, $2) AS ended_at
     FROM jobs
     WHERE started_at IS NOT NULL
       AND started_at < $2 AND coalesce(finished_at, $2) > $1`,
    [from, to],
  );
  const count = Math.ceil(seconds(from, to) / bucketSeconds - 1e-9);
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    start: seconds(reference, from) + i * bucketSeconds,
    used: new Map(),
  }));
  for (const job of rows) {
    const jobFrom = Math.max(0, seconds(from, job.started_at));
    const jobTo = Math.min(seconds(from, to), seconds(from, job.ended_at));
    const first = Math.floor(jobFrom / bucketSeconds);
    for (let i = first; i < count && i * bucketSeconds < jobTo; i++) {
      const overlap =
        Math.min(jobTo, (i + 1) * bucketSeconds) -
        Math.max(jobFrom, i * bucketSeconds);
      const used = buckets[i].used;
      used.set(job.tenant_id, (used.get(job.tenant_id) ?? 0) + overlap);
    }
  }
  return buckets;
}

// ---------------------------------------------------------------- output

function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) =>
    Math.max(...cells.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row.map((cell, i) => cell.padStart(widths[i])).join("  ");
  return [
    line(cells[0]),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...cells.slice(1).map(line),
  ].join("\n");
}

/**
 * One row per bucket: workers held by each tenant on average, and a bar of
 * the whole pool where every character is a slice of it ("." means idle).
 */
function shareChart(
  buckets: Bucket[],
  bucketSeconds: number,
  tenants: { id: string; symbol: string }[],
  pool: number,
): string {
  const BAR = 40;
  const decimals = bucketSeconds < 1 ? 2 : 0;
  const rows = buckets.map((bucket) => {
    const workers = tenants.map(
      (t) => (bucket.used.get(t.id) ?? 0) / bucketSeconds,
    );
    let bar = "";
    let total = 0;
    workers.forEach((w, i) => {
      total += w;
      const end = Math.min(BAR, Math.round((total / pool) * BAR));
      bar += tenants[i].symbol.repeat(Math.max(0, end - bar.length));
    });
    return [
      `${bucket.start >= 0 ? "+" : ""}${bucket.start.toFixed(decimals)}s`,
      ...workers.map((w) => w.toFixed(1)),
      `|${bar.padEnd(BAR, ".")}|`,
    ];
  });
  const legend = tenants.map((t) => `${t.symbol} = ${t.id}`).join(", ");
  return (
    table(
      ["time", ...tenants.map((t) => t.id), `pool of ${pool} workers`],
      rows,
    ) + `\n(average workers held per tenant. ${legend}, . = idle)`
  );
}

function sharesCsv(
  buckets: Bucket[],
  bucketSeconds: number,
  tenants: string[],
): string {
  const lines = ["bucket_start_s,tenant,worker_seconds,avg_workers,share_pct"];
  for (const bucket of buckets) {
    const total = [...bucket.used.values()].reduce((a, b) => a + b, 0);
    for (const tenant of tenants) {
      const used = bucket.used.get(tenant) ?? 0;
      lines.push(
        [
          bucket.start.toFixed(2),
          tenant,
          used.toFixed(3),
          (used / bucketSeconds).toFixed(3),
          total > 0 ? ((100 * used) / total).toFixed(2) : "0.00",
        ].join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}

async function save(name: string, content: string): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(`${RESULTS_DIR}/${name}`, content);
}

// ------------------------------------------------------- scenario 1: flood

async function flood(): Promise<void> {
  const smallTenants = [
    { id: "small-1", jobs: 5 },
    { id: "small-2", jobs: 7 },
    { id: "small-3", jobs: 8 },
    { id: "small-4", jobs: 10 },
  ];
  const out: string[] = [];
  const say = (text = "") => {
    console.log(text);
    out.push(text);
  };

  await reset();
  const pool = await poolSize();
  say(`FLOOD: one tenant floods the queue, then four small tenants arrive`);
  say(`pool: ${pool} worker slots, all tenants have weight 1\n`);

  say(
    `"big" submits ${FLOOD_JOBS.toLocaleString("en")} jobs (50 to 500 ms each) ...`,
  );
  const floodStart = await dbNow();
  const rate = await submitMany("big", FLOOD_JOBS, between(50, 500));
  say(
    `submitted through the API at ${Math.round(rate).toLocaleString("en")} jobs per second`,
  );
  await sleep(3000);

  const arrival = await dbNow();
  const waiting = await db.query(
    "SELECT count(*)::int AS n FROM jobs WHERE status = 'pending'",
  );
  say(
    `\n${waiting.rows[0].n.toLocaleString("en")} jobs of "big" are still waiting. ` +
      `Now the small tenants submit ${smallTenants.map((t) => t.jobs).join(", ")} jobs (100 to 400 ms each).`,
  );
  await Promise.all(
    smallTenants.map((t) =>
      Promise.all(
        Array.from({ length: t.jobs }, () => submit(t.id, between(100, 400)())),
      ),
    ),
  );

  // Wait for every small job to finish, then watch the pool go back to "big".
  const smallIds = smallTenants.map((t) => t.id);
  for (;;) {
    const left = await db.query(
      `SELECT count(*)::int AS n FROM jobs
       WHERE tenant_id = ANY($1) AND status <> 'succeeded'`,
      [smallIds],
    );
    if (left.rows[0].n === 0) break;
    if (seconds(arrival, await dbNow()) > 120) {
      throw new Error("small tenants did not finish within 2 minutes");
    }
    await sleep(100);
  }
  // The chart covers whole buckets: up to three before the small tenants
  // arrive, and at least three from their arrival on.
  const bucketsBefore = Math.min(
    3,
    Math.floor(seconds(floodStart, arrival) / BUCKET_SECONDS),
  );
  const bucketsAfter = Math.max(
    3,
    Math.ceil(seconds(arrival, await dbNow()) / BUCKET_SECONDS) + 1,
  );
  const from = addSeconds(arrival, -bucketsBefore * BUCKET_SECONDS);
  const end = addSeconds(arrival, bucketsAfter * BUCKET_SECONDS);
  await sleep(Math.max(0, seconds(await dbNow(), end) * 1000));

  // How long did the small tenants wait?
  const waits = await db.query(
    `SELECT tenant_id,
            count(*)::int AS jobs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY wait_ms) AS p95,
            max(wait_ms) AS max,
            extract(epoch FROM max(finished_at) - min(created_at))::float8 * 1000
              AS all_done
     FROM (
       SELECT tenant_id, created_at, finished_at,
              extract(epoch FROM started_at - created_at)::float8 * 1000 AS wait_ms
       FROM jobs WHERE tenant_id = ANY($1)
     ) small_jobs
     GROUP BY tenant_id ORDER BY tenant_id`,
    [smallIds],
  );
  say(`\nWait between submit and start, per small tenant:\n`);
  say(
    table(
      [
        "tenant",
        "jobs",
        "wait p50",
        "wait p95",
        "wait max",
        "all jobs done after",
      ],
      waits.rows.map((r) => [
        r.tenant_id,
        r.jobs,
        `${Math.round(r.p50)} ms`,
        `${Math.round(r.p95)} ms`,
        `${Math.round(r.max)} ms`,
        `${Math.round(r.all_done)} ms`,
      ]),
    ),
  );

  // What a single shared queue would have done to them.
  const ahead = await db.query(
    `SELECT count(*)::int AS n FROM jobs
     WHERE tenant_id = 'big' AND created_at <= $1
       AND (started_at IS NULL OR started_at > $1)`,
    [arrival],
  );
  const average = await db.query(
    `SELECT avg(extract(epoch FROM finished_at - started_at))::float8 AS s
     FROM jobs WHERE tenant_id = 'big' AND status = 'succeeded'`,
  );
  const fifoWait = (ahead.rows[0].n * average.rows[0].s) / pool;
  say(
    `\nFor comparison: in one first in, first out queue they would have waited behind ` +
      `${ahead.rows[0].n.toLocaleString("en")} jobs, about ${duration(fifoWait)}.`,
  );

  // How were the workers shared over time?
  const symbols = [
    { id: "big", symbol: "#" },
    ...smallTenants.map((t, i) => ({ id: t.id, symbol: String(i + 1) })),
  ];
  const buckets = await workerTime(from, end, BUCKET_SECONDS, arrival);
  say(
    `\nWorker share per ${BUCKET_SECONDS} s bucket (time 0 = small tenants submit):\n`,
  );
  say(shareChart(buckets, BUCKET_SECONDS, symbols, pool));

  const zoom = await workerTime(
    addSeconds(arrival, -0.5),
    addSeconds(arrival, 2.5),
    0.25,
    arrival,
  );
  say(`\nThe same, zoomed in on the moment they arrive (250 ms buckets):\n`);
  say(shareChart(zoom, 0.25, symbols, pool));

  await save("flood.txt", out.join("\n") + "\n");
  await save(
    "flood-waits.csv",
    "tenant,jobs,wait_p50_ms,wait_p95_ms,wait_max_ms,all_done_ms\n" +
      waits.rows
        .map((r) =>
          [r.tenant_id, r.jobs, r.p50, r.p95, r.max, r.all_done]
            .map((v) => (typeof v === "number" ? v.toFixed(1) : v))
            .join(","),
        )
        .join("\n") +
      "\n",
  );
  await save(
    "flood-shares.csv",
    sharesCsv(
      buckets,
      BUCKET_SECONDS,
      symbols.map((s) => s.id),
    ),
  );
}

// ----------------------------------------------------- scenario 2: weights

async function weights(): Promise<void> {
  // Very different job lengths on purpose: fairness is about worker time,
  // so the shares must follow the weights whatever the jobs look like.
  const tenants = [
    {
      id: "bronze",
      symbol: "b",
      weight: 1,
      jobs: 6000,
      sleepMs: between(50, 150),
    },
    {
      id: "silver",
      symbol: "s",
      weight: 2,
      jobs: 2500,
      sleepMs: between(200, 800),
    },
    {
      id: "gold",
      symbol: "G",
      weight: 4,
      jobs: 1200,
      sleepMs: between(1000, 3000),
    },
  ];
  const MEASURE_SECONDS = 60;
  const out: string[] = [];
  const say = (text = "") => {
    console.log(text);
    out.push(text);
  };

  await reset();
  const pool = await poolSize();
  say(
    `WEIGHTS: three tenants with weights 1, 2 and 4, all with a deep backlog`,
  );
  say(`pool: ${pool} worker slots`);
  say(
    `job lengths: bronze 50 to 150 ms, silver 200 to 800 ms, gold 1 to 3 s\n`,
  );

  await Promise.all(tenants.map((t) => submitMany(t.id, t.jobs, t.sleepMs)));
  await sleep(2000);
  const from = await dbNow();
  say(`measuring for ${MEASURE_SECONDS} seconds ...`);
  await sleep(MEASURE_SECONDS * 1000);
  const to = addSeconds(from, MEASURE_SECONDS);

  const stillWaiting = await db.query(
    `SELECT tenant_id FROM jobs WHERE status = 'pending' GROUP BY tenant_id`,
  );
  if (stillWaiting.rowCount !== tenants.length) {
    say(
      `WARNING: a tenant ran out of jobs, the shares below are not comparable`,
    );
  }

  const buckets = await workerTime(from, to, BUCKET_SECONDS);
  const whole = (await workerTime(from, to, MEASURE_SECONDS))[0];
  const total = [...whole.used.values()].reduce((a, b) => a + b, 0);
  const totalWeight = tenants.reduce((n, t) => n + t.weight, 0);
  const done = await db.query(
    `SELECT tenant_id, count(*)::int AS n FROM jobs
     WHERE status = 'succeeded' AND finished_at BETWEEN $1 AND $2
     GROUP BY tenant_id`,
    [from, to],
  );
  const doneBy = new Map(done.rows.map((r) => [r.tenant_id, r.n]));

  say(`\nShare of worker time over the ${MEASURE_SECONDS} seconds:\n`);
  say(
    table(
      ["tenant", "weight", "jobs done", "worker seconds", "share", "target"],
      tenants.map((t) => [
        t.id,
        t.weight,
        doneBy.get(t.id) ?? 0,
        (whole.used.get(t.id) ?? 0).toFixed(1),
        `${((100 * (whole.used.get(t.id) ?? 0)) / total).toFixed(1)}%`,
        `${((100 * t.weight) / totalWeight).toFixed(1)}%`,
      ]),
    ),
  );
  say(`\nWorker share per ${BUCKET_SECONDS} s bucket:\n`);
  say(shareChart(buckets, BUCKET_SECONDS, tenants, pool));

  await save("weights.txt", out.join("\n") + "\n");
  await save(
    "weights-shares.csv",
    sharesCsv(
      buckets,
      BUCKET_SECONDS,
      tenants.map((t) => t.id),
    ),
  );
}

// ------------------------------------------------------------------- main

const scenario = process.argv[2] ?? "all";
if (!["flood", "weights", "all"].includes(scenario)) {
  console.error("usage: node scripts/loadtest.ts [flood|weights]");
  process.exit(1);
}
await waitUntilReady();
if (scenario !== "weights") await flood();
if (scenario === "all") console.log("\n" + "=".repeat(78) + "\n");
if (scenario !== "flood") await weights();

await reset(); // leave the system empty
await db.end();
console.log(`\nresults written to ${RESULTS_DIR}/`);
