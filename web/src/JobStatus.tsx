import type { FormEvent } from "react";
import type { Job } from "./api.ts";
import { duration } from "./format.ts";
import { useJob, type Lookup } from "./useJob.ts";

interface Props {
  lookup: Lookup | null;
  onLookUp: (id: string) => void;
}

export function JobStatus({ lookup, onLookUp }: Props) {
  const view = useJob(lookup);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get("id")).trim();
    if (id) onLookUp(id);
  }

  return (
    <section className="card" aria-labelledby="status-title">
      <h2 id="status-title">Status of a job</h2>
      <p>
        Checked every second until it's done. After a submit, the first job
        shows up here.
      </p>

      <form className="fields fields-inline" onSubmit={submit}>
        <label>
          Job id
          {/* The key gives a new field, with the new id in it, when the page
              picks another job. */}
          <input
            key={lookup?.id}
            name="id"
            inputMode="numeric"
            pattern="[0-9]+"
            required
            defaultValue={lookup?.id}
          />
        </label>
        <button type="submit">Look up</button>
      </form>

      <div className="report" role="status">
        {lookup && view?.state === "missing" && (
          <p>There is no job with the id {lookup.id}.</p>
        )}
        {view?.job && <Facts job={view.job} />}
        {view?.state === "lost" && <p>No answer from the API, trying again.</p>}
      </div>
    </section>
  );
}

const STATUS: Record<Job["status"], string> = {
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed, it will be tried again",
  dead: "dead, it is not tried again",
};

function Facts({ job }: { job: Job }) {
  const since = (time: string | null) =>
    time === null
      ? "not yet"
      : `${duration(Date.parse(time) - Date.parse(job.created_at))} after it was submitted`;
  const attempt = job.attempts > 1 ? ` (attempt ${job.attempts})` : "";

  return (
    <dl className="facts">
      <dt>Status</dt>
      <dd>{STATUS[job.status]}</dd>
      <dt>Tenant</dt>
      <dd>{job.tenant_id}</dd>
      <dt>Attempts</dt>
      <dd>
        {job.attempts} of {job.max_attempts}
      </dd>
      <dt>Started</dt>
      <dd>{since(job.started_at) + (job.started_at ? attempt : "")}</dd>
      <dt>Finished</dt>
      <dd>{since(job.finished_at)}</dd>
      {job.last_error && (
        <>
          <dt>Last error</dt>
          <dd>{job.last_error}</dd>
        </>
      )}
    </dl>
  );
}
