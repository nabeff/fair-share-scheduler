import { useEffect, useState } from "react";
import { getJob, type Job } from "./api.ts";

/** A new object on every lookup, so the same id can be asked again. */
export interface Lookup {
  id: string;
}

export interface JobView {
  job: Job | null;
  /** `lost`: the last call failed, still retrying. */
  state: "found" | "missing" | "lost";
}

const ENDED = ["succeeded", "dead"];

/** Polls a job every second until it ends. */
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

  // Ignore answers to an earlier lookup.
  return answer?.to === lookup ? answer.view : null;
}
