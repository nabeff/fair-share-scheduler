import { useEffect, useState } from "react";
import { getPool, type Pool } from "./api.ts";
import { addSample, emptyHistory, type History } from "./history.ts";

export type Connection = "connecting" | "live" | "lost";

export interface PoolView {
  history: History;
  connection: Connection;
}

const LATE_AFTER_BEATS = 2;

/** Timers may fire slightly early, still count it for that beat. */
const EARLY = 0.1;

/** Polls GET /pool every second. Simple, and the API stays stateless. */
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
      // Skip a beat while the last call is still out, so calls don't pile up.
      if (reading) {
        if (Date.now() - askedAt >= LATE_AFTER_BEATS * everyMs) {
          setView(({ history }) => ({ history, connection: "lost" }));
        }
        return;
      }
      reading = true;
      askedAt = Date.now();
      // Stamp with the beat, not the clock: a late timer would leave a gap.
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
        setView(({ history }) => ({ history, connection: "lost" }));
      } finally {
        reading = false;
      }
    }

    void read();
    // A fixed beat: background tabs only wake once a second.
    const beat = setInterval(read, everyMs);
    return () => {
      stop.abort();
      clearInterval(beat);
    };
  }, [load, everyMs]);

  return view;
}
