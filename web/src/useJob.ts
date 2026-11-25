import { useEffect, useState } from "react";
import { getJob, type Job } from "./api.ts";

/** A question about one job. A new object for every time it is asked. */
export interface Lookup {
  id: string;
}

export interface JobView {
  /** The last answer. Null when the job does not exist, or nothing is known yet. */
  job: Job | null;
  /** `lost` means the API did not answer the last time, and we keep trying. */
  state: "found" | "missing" | "lost";
}

/** Nothing changes any more once a job is in one of these. */
const ENDED = ["succeeded", "dead"];

/**
 * Reads one job, and reads it again every second until it has ended.
 * Returns null while the first answer is on its way.
 */
export function useJob(lookup: Lookup | null, everyMs = 1000): JobView | null {
  const [answer, setAnswer] = useState<{ to: Lookup; view: JobView } | null>(
    null,
  );

  useEffect(() => {
    if (!lookup) return;
    const question = lookup;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      try {
        const job = await getJob(question.id, stop.signal);
        if (stop.signal.aborted) return;
        setAnswer({
          to: question,
          view: { job, state: job ? "found" : "missing" },
        });
        if (job === null || ENDED.includes(job.status)) return;
      } catch {
        if (stop.signal.aborted) return;
        setAnswer((last) => ({
          to: question,
          view: {
            job: last?.to === question ? last.view.job : null,
            state: "lost",
          },
        }));
      }
      timer = setTimeout(read, everyMs);
    }

    void read();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [lookup, everyMs]);

  // An answer to an earlier question says nothing about this one.
  return answer?.to === lookup ? answer.view : null;
}
