import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { SubmitForm } from "./SubmitForm.tsx";

const stored = () =>
  new Response(JSON.stringify({ id: "7", status: "pending" }), { status: 201 });

/** Fills the form the way a person does, and presses Submit. */
async function submit(tenant: string, jobs: string, ms: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Tenant" }));
  await user.click(screen.getByRole("option", { name: tenant }));
  await user.clear(screen.getByLabelText("Jobs"));
  await user.type(screen.getByLabelText("Jobs"), jobs);
  await user.clear(screen.getByLabelText("Each takes (ms)"));
  await user.type(screen.getByLabelText("Each takes (ms)"), ms);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  return user;
}

describe("the form that submits jobs", () => {
  test("stores the jobs for the chosen tenant and says how many", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => stored());
    vi.stubGlobal("fetch", fetch);
    render(<SubmitForm tenants={["supermarket", "cafe"]} />);

    await submit("cafe", "3", "250");

    await screen.findByText("3 jobs stored for cafe.");
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/jobs");
    expect(JSON.parse(String(init.body))).toEqual({
      tenant_id: "cafe",
      payload: { sleep_ms: 250 },
    });
  });

  test("one job is called a job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stored()),
    );
    render(<SubmitForm tenants={["supermarket"]} />);

    await submit("supermarket", "1", "100");

    await screen.findByText("1 job stored for supermarket.");
  });

  // The status panel shows this job: the first one the tenant gets started.
  test("hands the first job of the batch to the page", async () => {
    const ids = ["12", "9", "10"];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: ids.shift() }), { status: 201 }),
      ),
    );
    const onStored = vi.fn();
    render(<SubmitForm tenants={["supermarket"]} onStored={onStored} />);

    await submit("supermarket", "3", "100");

    await screen.findByText("3 jobs stored for supermarket.");
    expect(onStored).toHaveBeenCalledExactlyOnceWith("9");
  });

  test("stops at the first refusal and says why", async () => {
    const refused = () =>
      new Response(
        JSON.stringify({ error: "temporarily unavailable, retry" }),
        {
          status: 503,
        },
      );
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => stored())
      .mockImplementationOnce(async () => stored())
      .mockImplementation(async () => refused());
    vi.stubGlobal("fetch", fetch);
    render(<SubmitForm tenants={["supermarket"]} />);

    await submit("supermarket", "500", "100");

    await screen.findByText(
      "Stopped after 2 of 500 jobs: temporarily unavailable, retry",
    );
    expect(fetch.mock.calls.length).toBeLessThan(20);
  });

  test("the stop button ends a batch that is running", async () => {
    // An API that never answers, until the page gives up on the call.
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
    render(<SubmitForm tenants={["supermarket"]} />);

    const user = await submit("supermarket", "100", "100");
    await screen.findByText("Storing 0 of 100 jobs");
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
      "disabled",
      true,
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await screen.findByText("Stopped. 0 of 100 jobs stored.");
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  test("an example is sent with one press", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => stored());
    vi.stubGlobal("fetch", fetch);
    const onStored = vi.fn();
    render(
      <SubmitForm tenants={["supermarket", "cafe"]} onStored={onStored} />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "5 jobs for cafe" }));

    await screen.findByText("5 jobs stored for cafe.");
    const jobs = fetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init.body)),
    );
    expect(jobs.map((job) => job.tenant_id)).toEqual(Array(5).fill("cafe"));
    // The jobs of an example are not all one length, and an example sends
    // the same lengths every time.
    const lengths: number[] = jobs.map((job) => job.payload.sleep_ms);
    expect(lengths.sort((a, b) => a - b)).toEqual([
      1000, 1473, 1946, 2237, 2710,
    ]);
    expect(onStored).toHaveBeenCalledExactlyOnceWith("7");
  });

  test("an example for several tenants sends one batch after the other", async () => {
    const sent: string[] = [];
    const lengths: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const job = JSON.parse(String(init.body));
        sent.push(job.tenant_id);
        lengths.push(job.payload.sleep_ms);
        return stored();
      }),
    );
    render(<SubmitForm tenants={["school", "bank", "hotel"]} />);

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Flood bank, hotel and school",
      }),
    );

    await screen.findByText("1,350 jobs stored for bank, hotel and school.");
    const jobsOf = (tenant: string) => sent.filter((t) => t === tenant).length;
    expect([jobsOf("bank"), jobsOf("hotel"), jobsOf("school")]).toEqual([
      700, 400, 250,
    ]);
    // One batch is over before the next one starts.
    expect(sent.lastIndexOf("bank")).toBeLessThan(sent.indexOf("hotel"));
    // Every job takes between 1 and 3 seconds, and the lengths use that room.
    const shortest = Math.min(...lengths);
    const longest = Math.max(...lengths);
    expect(shortest).toBeGreaterThanOrEqual(1000);
    expect(longest).toBeLessThanOrEqual(3000);
    expect(longest - shortest).toBeGreaterThan(1900);
  });

  test("an example that fails stops there and says why", async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => stored())
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: "unknown tenant" }), {
            status: 404,
          }),
      );
    vi.stubGlobal("fetch", fetch);
    render(<SubmitForm tenants={["school", "bank", "hotel"]} />);

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Flood bank, hotel and school",
      }),
    );

    await screen.findByText("Stopped after 1 of 1,350 jobs: unknown tenant");
    expect(fetch.mock.calls.length).toBeLessThan(20);
  });

  // The examples name tenants of tenants.json. Someone may have changed it.
  test("an example is only offered when its tenants exist", () => {
    render(<SubmitForm tenants={["supermarket", "bank"]} />);

    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Submit", "Flood supermarket with 600 jobs"]);
  });

  test("waits for the list of tenants before it can be used", () => {
    render(<SubmitForm tenants={[]} />);

    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen
        .getByRole("combobox", { name: "Tenant" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
