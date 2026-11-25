import { describe, expect, test } from "vitest";
import { sendAll } from "./sendAll.ts";

/** A call that ends when the test says so. */
function slowCalls() {
  const open: (() => void)[] = [];
  const send = () => new Promise<void>((resolve) => void open.push(resolve));
  /** Lets every call that is out end, and waits for what that sets off. */
  const finishOpenCalls = async () => {
    open.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { open, send, finishOpenCalls };
}

describe("sending a batch", () => {
  test("sends every job, and only a few at a time", async () => {
    const { open, send, finishOpenCalls } = slowCalls();
    const progress: number[] = [];

    const batch = sendAll(7, send, {
      atOnce: 3,
      onProgress: (done) => progress.push(done),
    });
    expect(open).toHaveLength(3);
    await finishOpenCalls();
    expect(open).toHaveLength(3);
    await finishOpenCalls();
    expect(open).toHaveLength(1);
    await finishOpenCalls();

    expect(await batch).toEqual({ done: 7 });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("gives every call its own number", async () => {
    const numbers: number[] = [];

    await sendAll(5, async (index) => void numbers.push(index), { atOnce: 2 });

    expect(numbers.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  // If the API refuses one job, it will refuse the 4,999 after it as well.
  test("stops at the first failure and hands it back", async () => {
    const refusal = new Error("temporarily unavailable, retry");
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls > 4) throw refusal;
    };

    const batch = await sendAll(1000, send, { atOnce: 2 });

    expect(batch).toEqual({ done: 4, error: refusal });
    expect(calls).toBeLessThan(10);
  });

  test("stops when the caller says so, and that is not a failure", async () => {
    const stop = new AbortController();
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 3) stop.abort();
      if (stop.signal.aborted) throw stop.signal.reason;
    };

    const batch = await sendAll(1000, send, { atOnce: 1, signal: stop.signal });

    expect(batch).toEqual({ done: 2 });
    expect(calls).toBe(3);
  });
});
