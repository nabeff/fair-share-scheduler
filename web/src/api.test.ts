import { describe, expect, test, vi } from "vitest";
import { ApiError, getJob, getPool, submitJob } from "./api.ts";

/** Makes fetch answer with this status and body. */
function answer(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(text, { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const pool = {
  slots: 20,
  tenants: [{ id: "supermarket", weight: 1, running: 12, waiting: 300 }],
};

describe("the API client", () => {
  test("reads the pool from /api/pool", async () => {
    const fetch = answer(200, pool);

    expect(await getPool()).toEqual(pool);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/pool");
  });

  test("an answer that is not a pool is refused", async () => {
    answer(200, { slots: 20, tenants: "none" });

    await expect(getPool()).rejects.toBeInstanceOf(ApiError);
  });

  test("a refusal carries the status and the words of the API", async () => {
    answer(503, { error: "temporarily unavailable, retry" });

    await expect(getPool()).rejects.toMatchObject({
      status: 503,
      message: "temporarily unavailable, retry",
    });
  });

  // nginx answers in place of the API when the API is down.
  test("an error page that is not JSON still gives the status", async () => {
    answer(502, "<html>502 Bad Gateway</html>");

    await expect(getPool()).rejects.toMatchObject({ status: 502 });
  });

  test("no answer at all is status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(getPool()).rejects.toMatchObject({ status: 0 });
  });

  // A component that goes away stops its call. That is not news about the API.
  test("a call stopped by the caller is not a failure of the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal!;
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );
    const stop = new AbortController();

    const call = getPool(stop.signal);
    stop.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a job is sent as tenant and payload, and its id comes back", async () => {
    const fetch = answer(201, { id: "42", status: "pending" });

    expect(await submitJob("cafe", { sleep_ms: 100 })).toBe("42");

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/jobs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tenant_id: "cafe",
      payload: { sleep_ms: 100 },
    });
  });

  test("a job is read by its id", async () => {
    const job = {
      id: "42",
      tenant_id: "cafe",
      status: "succeeded",
      attempts: 1,
      max_attempts: 3,
      created_at: "2026-11-24T20:51:53.543Z",
      started_at: "2026-11-24T20:51:53.582Z",
      finished_at: "2026-11-24T20:51:53.632Z",
      run_at: "2026-11-24T20:51:53.543Z",
      last_error: null,
    };
    const fetch = answer(200, job);

    expect(await getJob("42")).toEqual(job);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/jobs/42");
  });

  test("a job that does not exist reads as null", async () => {
    answer(404, { error: "job not found" });

    expect(await getJob("999")).toBeNull();
  });
});
