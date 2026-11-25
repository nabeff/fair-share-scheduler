import { useEffect, useRef, useState, type FormEvent } from "react";
import { submitJob } from "./api.ts";
import { count, list } from "./format.ts";
import { sendAll } from "./sendAll.ts";
import { TenantPicker } from "./TenantPicker.tsx";

/** Jobs of one tenant that are sent together. */
interface Batch {
  tenant: string;
  jobs: number;
  /** How long job number `index` of the batch takes, in ms. */
  ms: (index: number) => number;
}

/**
 * The length of job number `index` of an example: between 1 and 3 seconds.
 * Real jobs are not all one length. Jobs of one length that start together
 * also end together, and then the whole pool changes hands in one instant.
 * The length follows from the number, without chance, so an example sends
 * the same jobs every time. The step of 1237 ms walks through the 2 seconds
 * in big jumps: two jobs in a row never take about the same time.
 */
const mixed = (index: number) => 1000 + ((index * 1237) % 2001);

/**
 * Batches that are ready to send. The first two tell the story of the brief:
 * one tenant floods the queue, then a small tenant arrives. The third shows
 * the weights. They name tenants of tenants.json, and an example is only
 * offered while its tenants exist.
 */
const EXAMPLES: { label: string; batches: Batch[] }[] = [
  {
    label: "Flood supermarket with 600 jobs",
    batches: [{ tenant: "supermarket", jobs: 600, ms: mixed }],
  },
  {
    label: "5 jobs for cafe",
    batches: [{ tenant: "cafe", jobs: 5, ms: mixed }],
  },
  {
    label: "Flood bank, hotel and school",
    batches: [
      { tenant: "bank", jobs: 700, ms: mixed },
      { tenant: "hotel", jobs: 400, ms: mixed },
      { tenant: "school", jobs: 250, ms: mixed },
    ],
  },
];

/** What the line under the form says. */
type Report =
  | { state: "sending"; done: number; total: number }
  | { state: "stored"; done: number; tenants: string[] }
  | { state: "stopped"; done: number; total: number }
  | { state: "failed"; done: number; total: number; reason: string };

/** "1 job", "200 jobs". */
const jobs = (n: number) => `${count(n)} ${n === 1 ? "job" : "jobs"}`;

function words(report: Report): string {
  switch (report.state) {
    case "sending":
      return `Storing ${count(report.done)} of ${jobs(report.total)}`;
    case "stored":
      return `${jobs(report.done)} stored for ${list(report.tenants)}.`;
    case "stopped":
      return `Stopped. ${count(report.done)} of ${jobs(report.total)} stored.`;
    case "failed":
      return `Stopped after ${count(report.done)} of ${jobs(report.total)}: ${report.reason}`;
  }
}

interface Props {
  /** The tenants to choose from. Empty until the API has named them. */
  tenants: string[];
  /** Called after a batch with the id of its first job. */
  onStored?: (firstJobId: string) => void;
}

/**
 * Submits jobs the way any client does: one POST /jobs for each. The page has
 * no door of its own into the scheduler.
 */
export function SubmitForm({ tenants, onStored }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  // The batch that is running, if any. Aborting it stops the batch.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const sending = report?.state === "sending";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ms = Number(form.get("ms"));
    void send([
      {
        tenant: String(form.get("tenant")),
        jobs: Number(form.get("jobs")),
        ms: () => ms,
      },
    ]);
  }

  /** Sends the batches one after the other, and reports on all of them. */
  async function send(batches: Batch[]) {
    const total = batches.reduce((sum, batch) => sum + batch.jobs, 0);
    const stop = new AbortController();
    running.current = stop;
    setReport({ state: "sending", done: 0, total });

    // A large batch gets thousands of answers a second. Repainting for a
    // hundred of them is enough to see it move.
    const step = Math.ceil(total / 100);
    // The job with the lowest id is the one that gets started first.
    let first: bigint | undefined;
    let done = 0;
    let failure: { error: unknown } | undefined;
    for (const { tenant, jobs, ms } of batches) {
      const before = done;
      const batch = await sendAll(
        jobs,
        async (index) => {
          const payload = { sleep_ms: ms(index) };
          const id = await submitJob(tenant, payload, stop.signal);
          if (first === undefined || BigInt(id) < first) first = BigInt(id);
        },
        {
          signal: stop.signal,
          onProgress: (sent) => {
            const now = before + sent;
            if (now % step === 0)
              setReport({ state: "sending", done: now, total });
          },
        },
      );
      done = before + batch.done;
      if ("error" in batch) failure = { error: batch.error };
      if (failure || stop.signal.aborted) break;
    }
    if (first !== undefined) onStored?.(String(first));

    if (stop.signal.aborted) {
      setReport({ state: "stopped", done, total });
    } else if (failure) {
      const reason =
        failure.error instanceof Error
          ? failure.error.message
          : "unknown error";
      setReport({ state: "failed", done, total, reason });
    } else {
      const tenants = batches.map((batch) => batch.tenant);
      setReport({ state: "stored", done, tenants });
    }
  }

  const examples = EXAMPLES.filter((example) =>
    example.batches.every((batch) => tenants.includes(batch.tenant)),
  );

  return (
    <section className="card" aria-labelledby="submit-title">
      <h2 id="submit-title">Submit jobs</h2>
      <p>
        A job just sleeps for the time you set. The scheduler never sees that
        time.
      </p>

      <form className="fields" onSubmit={submit}>
        <div className="wide">
          <TenantPicker label="Tenant" name="tenant" options={tenants} />
        </div>
        <label>
          Jobs
          <input
            name="jobs"
            type="number"
            required
            min={1}
            max={5000}
            defaultValue={200}
          />
        </label>
        <label>
          Each takes (ms)
          <input
            name="ms"
            type="number"
            required
            min={0}
            max={300_000}
            defaultValue={2000}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={sending || tenants.length === 0}>
            Submit
          </button>
          {sending && (
            <button
              type="button"
              className="quiet"
              onClick={() => running.current?.abort()}
            >
              Stop
            </button>
          )}
        </div>
      </form>

      {examples.length > 0 && (
        <div className="examples">
          <p>
            Or try an example. Flood the supermarket first, then send the cafe's
            jobs while it runs.
          </p>
          <div className="actions">
            {examples.map((example) => (
              <button
                key={example.label}
                type="button"
                className="quiet"
                disabled={sending}
                onClick={() => void send(example.batches)}
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="report" role="status">
        {report && words(report)}
      </p>
    </section>
  );
}
