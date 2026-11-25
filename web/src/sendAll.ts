export interface Batch {
  /** Calls that worked. */
  done: number;
  /** The failure that ended the batch early. Absent when the caller stopped it. */
  error?: unknown;
}

interface Options {
  /**
   * Calls that are out at the same time. A browser opens six connections to
   * one address, so more than six would only wait in the browser.
   */
  atOnce?: number;
  /** Aborted by the caller to stop the batch. */
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}

/**
 * Calls `send` once for every number from 0 to count - 1, a few at a time.
 *
 * The first failure ends the batch: what the API refuses once, it refuses
 * for the rest as well. Nothing is tried again. A person is watching and
 * can press the button again, and a second try of a call whose answer was
 * lost could store the same job twice.
 */
export async function sendAll(
  count: number,
  send: (index: number) => Promise<void>,
  { atOnce = 6, signal, onProgress }: Options = {},
): Promise<Batch> {
  const batch: Batch = { done: 0 };
  let next = 0;

  // One lane sends one call after the other. Several lanes run side by side.
  async function lane() {
    while (next < count && !("error" in batch) && !signal?.aborted) {
      try {
        await send(next++);
        batch.done += 1;
        onProgress?.(batch.done);
      } catch (err) {
        if (signal?.aborted) return; // stopped by the caller, not by the API
        if (!("error" in batch)) batch.error = err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(atOnce, count) }, lane));
  return batch;
}
