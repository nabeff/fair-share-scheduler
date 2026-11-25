import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, type Pool } from "./api.ts";
import { usePool } from "./usePool.ts";

const pool = (running: number): Pool => ({
  slots: 20,
  tenants: [{ id: "supermarket", weight: 1, running, waiting: 0 }],
});

/** Lets this much time pass, with every timer and every answer in it. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("usePool", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  test("reads the pool at once, and then once a second", async () => {
    const load = vi.fn().mockResolvedValue(pool(3));

    const { result } = renderHook(() => usePool(load));
    expect(result.current.connection).toBe("connecting");

    await wait(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe("live");
    expect(result.current.history.samples).toHaveLength(1);

    await wait(3000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.history.samples).toHaveLength(4);
  });

  test("when the API stops answering, the last picture stays", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(pool(3))
      .mockRejectedValueOnce(new ApiError(0, "The API does not answer."))
      .mockResolvedValue(pool(5));
    const { result } = renderHook(() => usePool(load));

    await wait(0);
    await wait(1000);
    expect(result.current.connection).toBe("lost");
    expect(result.current.history.samples).toHaveLength(1);

    // It keeps trying, and it is live again with the first answer.
    await wait(1000);
    expect(result.current.connection).toBe("live");
    expect(result.current.history.samples).toHaveLength(2);
  });

  test("a slow answer does not start a second call", async () => {
    let answer!: (pool: Pool) => void;
    const load = vi.fn(
      () => new Promise<Pool>((resolve) => void (answer = resolve)),
    );
    renderHook(() => usePool(load));

    await wait(5000);
    expect(load).toHaveBeenCalledTimes(1);

    // The seconds in between were skipped. The next one is read again.
    answer(pool(1));
    await wait(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A frozen API, or a proxy that waits for one: the call hangs for seconds
  // before it fails. The page must not say "live" all that time.
  test("an answer that is two seconds late already counts as no answer", async () => {
    let answer!: (pool: Pool) => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce(pool(3))
      .mockImplementation(
        () => new Promise<Pool>((resolve) => void (answer = resolve)),
      );
    const { result } = renderHook(() => usePool(load));
    await wait(0);

    await wait(2000); // asked at 1 s, so the answer is 1 s late now
    expect(result.current.connection).toBe("live");

    await wait(1000);
    expect(result.current.connection).toBe("lost");
    expect(result.current.history.samples).toHaveLength(1);

    answer(pool(5));
    await wait(0);
    expect(result.current.connection).toBe("live");
    expect(load).toHaveBeenCalledTimes(2);
  });

  // The chart places a sample by its time. The time of the question is as
  // regular as the clock, the time of the answer is not.
  test("a sample carries the time it was asked for", async () => {
    vi.setSystemTime(50_000);
    let answer!: (pool: Pool) => void;
    const load = vi.fn(
      () => new Promise<Pool>((resolve) => void (answer = resolve)),
    );
    const { result } = renderHook(() => usePool(load));

    await wait(400);
    answer(pool(1));
    await wait(0);

    expect(result.current.history.samples[0]?.at).toBe(50_000);
  });

  // No timer fires exactly on time, and in a tab in the background it can
  // fire most of a second late. The sample still belongs to the second it was
  // asked for. Placed by the clock, it would double the next second and leave
  // a hole in its own.
  test("a beat that fires late keeps its own second", async () => {
    vi.setSystemTime(50_000);
    const load = vi.fn().mockResolvedValue(pool(3));
    const { result } = renderHook(() => usePool(load));
    await wait(0);

    vi.setSystemTime(50_600); // from here the timers run 0.6 s behind the clock
    await wait(1000); // the beat of second 1 fires at 51.6 s
    vi.setSystemTime(51_000);
    await wait(1000); // the beat of second 2 fires on time, at 52.0 s

    expect(result.current.history.samples.map((sample) => sample.at)).toEqual([
      50_000, 51_000, 52_000,
    ]);
  });

  // Date.now() and the timers do not read the same clock, so a beat can seem
  // to fire a few milliseconds before its second.
  test("a beat that fires a little early still counts for its second", async () => {
    vi.setSystemTime(50_000);
    const load = vi.fn().mockResolvedValue(pool(3));
    const { result } = renderHook(() => usePool(load));
    await wait(0);

    vi.setSystemTime(49_950); // from here the timers run 50 ms ahead of the clock
    await wait(1000); // the beat of second 1 fires at 50.95 s

    expect(result.current.history.samples.map((sample) => sample.at)).toEqual([
      50_000, 51_000,
    ]);
  });

  test("stops when the page no longer shows it", async () => {
    const load = vi.fn().mockResolvedValue(pool(3));
    const { unmount } = renderHook(() => usePool(load));
    await wait(0);

    unmount();
    await wait(5000);

    expect(load).toHaveBeenCalledTimes(1);
    const signal: AbortSignal = load.mock.calls[0]?.[0];
    expect(signal.aborted).toBe(true);
  });
});
