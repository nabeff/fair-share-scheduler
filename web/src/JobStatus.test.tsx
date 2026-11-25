import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Job } from "./api.ts";
import { JobStatus } from "./JobStatus.tsx";

const job = (changes: Partial<Job>): Job => ({
  id: "42",
  tenant_id: "cafe",
  status: "running",
  attempts: 1,
  max_attempts: 3,
  created_at: "2026-11-24T20:51:53.000Z",
  started_at: "2026-11-24T20:51:53.212Z",
  finished_at: null,
  run_at: "2026-11-24T20:51:53.000Z",
  last_error: null,
  ...changes,
});

/** Makes the API answer GET /jobs/:id with these, one after the other. */
function answers(...bodies: (Job | null)[]) {
  const fetch = vi.fn(async (_url: string) => {
    const body = bodies.length > 1 ? bodies.shift() : bodies[0];
    return body
      ? new Response(JSON.stringify(body))
      : new Response(JSON.stringify({ error: "job not found" }), {
          status: 404,
        });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The value printed beside a label, like "Status". */
const fact = (label: string) =>
  screen.getByText(label).nextElementSibling?.textContent;

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("the status of a job", () => {
  afterEach(() => void vi.useRealTimers());

  test("asks for the job whose id was typed", async () => {
    const onLookUp = vi.fn();
    const user = userEvent.setup();
    render(<JobStatus lookup={null} onLookUp={onLookUp} />);

    await user.type(screen.getByLabelText("Job id"), "42");
    await user.click(screen.getByRole("button", { name: "Look up" }));

    expect(onLookUp).toHaveBeenCalledWith("42");
  });

  test("shows how long the job waited and how it ended", async () => {
    const fetch = answers(
      job({ status: "succeeded", finished_at: "2026-11-24T20:51:55.412Z" }),
    );
    render(<JobStatus lookup={{ id: "42" }} onLookUp={() => {}} />);

    await screen.findByText("succeeded");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/jobs/42");
    expect(fact("Tenant")).toBe("cafe");
    expect(fact("Attempts")).toBe("1 of 3");
    expect(fact("Started")).toBe("212 ms after it was submitted");
    expect(fact("Finished")).toBe("2.4 s after it was submitted");
  });

  test("follows a job until it has ended, and then stops asking", async () => {
    vi.useFakeTimers();
    const fetch = answers(
      job({ status: "pending", attempts: 0, started_at: null }),
      job({ status: "running" }),
      job({ status: "succeeded", finished_at: "2026-11-24T20:51:55.412Z" }),
    );
    render(<JobStatus lookup={{ id: "42" }} onLookUp={() => {}} />);

    await wait(0);
    expect(fact("Status")).toBe("pending");
    expect(fact("Started")).toBe("not yet");

    await wait(1000);
    expect(fact("Status")).toBe("running");

    await wait(1000);
    expect(fact("Status")).toBe("succeeded");

    await wait(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("a failed attempt shows the error and that the job is tried again", async () => {
    answers(
      job({ status: "failed", attempts: 2, last_error: "lease expired" }),
    );
    render(<JobStatus lookup={{ id: "42" }} onLookUp={() => {}} />);

    await screen.findByText("failed, it will be tried again");
    expect(fact("Attempts")).toBe("2 of 3");
    expect(fact("Started")).toBe("212 ms after it was submitted (attempt 2)");
    expect(fact("Last error")).toBe("lease expired");
  });

  test("says so when there is no job with this id", async () => {
    vi.useFakeTimers();
    const fetch = answers(null);
    render(<JobStatus lookup={{ id: "999" }} onLookUp={() => {}} />);

    await wait(0);
    expect(screen.getByText("There is no job with the id 999.")).toBeTruthy();

    await wait(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("asking again for the same id reads it again", async () => {
    vi.useFakeTimers();
    const fetch = answers(null);
    const { rerender } = render(
      <JobStatus lookup={{ id: "999" }} onLookUp={() => {}} />,
    );
    await wait(0);

    rerender(<JobStatus lookup={{ id: "999" }} onLookUp={() => {}} />);
    await wait(0);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("a question about another job does not show the last job", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify(job({ status: "succeeded" }))),
      )
      .mockImplementation(() => new Promise(() => {})); // no answer yet
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(
      <JobStatus lookup={{ id: "42" }} onLookUp={() => {}} />,
    );
    await wait(0);
    expect(fact("Status")).toBe("succeeded");

    rerender(<JobStatus lookup={{ id: "43" }} onLookUp={() => {}} />);
    await wait(0);

    expect(screen.queryByText("Status")).toBeNull();
  });

  test("keeps the last answer while the API is away", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify(job({ status: "running" }))),
      )
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    render(<JobStatus lookup={{ id: "42" }} onLookUp={() => {}} />);

    await wait(0);
    await wait(1000);

    expect(fact("Status")).toBe("running");
    expect(
      screen.getByText("No answer from the API, trying again."),
    ).toBeTruthy();
  });
});
