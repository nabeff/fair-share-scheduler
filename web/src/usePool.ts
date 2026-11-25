import { useEffect, useState } from "react";
import { getPool, type Pool } from "./api.ts";
import { addSample, emptyHistory, type History } from "./history.ts";

/** Before the first answer, while answers come, and while they do not. */
export type Connection = "connecting" | "live" | "lost";

export interface PoolView {
  history: History;
  connection: Connection;
}

/** An answer that is this many seconds late counts as no answer. */
const LATE_AFTER_BEATS = 2;

/** A timer that fires up to this part of a beat early still counts for it. */
const EARLY = 0.1;

/**
 * Reads the pool once a second and keeps the last minute.
 *
 * Polling, not a push from the server: one small GET a second is enough for
 * a picture that changes once a second, and the API stays stateless.
 */
export function usePool(
  load: (signal: AbortSignal) => Promise<Pool> = getPool,
  everyMs = 1000,
): PoolView {
  const [view, setView] = useState<PoolView>({
    history: emptyHistory,
    connection: "connecting",
  });

  useEffect(() => {
    const stop = new AbortController();
    const firstBeatAt = Date.now();
    let reading = false;
    let askedAt = 0;

    async function read() {
      // A second that comes while the last call is still out is skipped, so
      // slow answers never pile up. A call can hang for seconds before it
      // fails, and the page must not say "live" all that time.
      if (reading) {
        if (Date.now() - askedAt >= LATE_AFTER_BEATS * everyMs) {
          setView(({ history }) => ({ history, connection: "lost" }));
        }
        return;
      }
      reading = true;
      askedAt = Date.now();
      // The sample is stamped with the time of its beat, not with the clock.
      // No timer fires exactly on time, and in a tab in the background one can
      // fire most of a second late. Placed by the clock, such a sample would
      // land on the next second and leave a hole in its own.
      const beat = Math.floor((askedAt - firstBeatAt) / everyMs + EARLY);
      const at = firstBeatAt + beat * everyMs;
      try {
        const pool = await load(stop.signal);
        if (stop.signal.aborted) return;
        setView(({ history }) => ({
          history: addSample(history, { at, pool }),
          connection: "live",
        }));
      } catch {
        if (stop.signal.aborted) return;
        // Keep what we have. The page shows it dimmed and says why.
        setView(({ history }) => ({ history, connection: "lost" }));
      } finally {
        reading = false;
      }
    }

    void read();
    // A fixed beat, not "a second after the last answer": a browser lets a
    // tab in the background wake up once a second at most, and a wait that
    // starts after each answer would then read every other second only.
    const beat = setInterval(read, everyMs);
    return () => {
      stop.abort();
      clearInterval(beat);
    };
  }, [load, everyMs]);

  return view;
}
