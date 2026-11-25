import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const pool = {
  slots: 20,
  tenants: [
    { id: "supermarket", weight: 1, running: 15, waiting: 99280 },
    { id: "bank", weight: 4, running: 5, waiting: 0 },
    { id: "cafe", weight: 1, running: 0, waiting: 0 },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A stand-in for the API: the pool above, and jobs that are stored and run. */
function api() {
  let lastId = 40;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/pool") return json(pool);
    if (url === "/api/jobs" && init?.method === "POST") {
      return json({ id: String(++lastId), status: "pending" }, 201);
    }
    const id = url.replace("/api/jobs/", "");
    return json({
      id,
      tenant_id: "cafe",
      status: "succeeded",
      attempts: 1,
      max_attempts: 3,
      created_at: "2026-11-24T20:51:53.000Z",
      started_at: "2026-11-24T20:51:53.212Z",
      finished_at: "2026-11-24T20:51:53.300Z",
      run_at: "2026-11-24T20:51:53.000Z",
      last_error: null,
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The number in the tile with this label. */
const tile = (label: string) =>
  screen.getByText(label).nextElementSibling?.textContent;

describe("the page", () => {
  test("shows the pool that the API reports", async () => {
    api();
    render(<App />);

    await screen.findByText("Live");
    expect(tile("Workers in the pool")).toBe("20");
    expect(tile("Busy")).toBe("20");
    expect(tile("Idle")).toBe("0");
    expect(tile("Jobs waiting")).toBe("99,280");

    const row = screen.getByRole("row", { name: /^bank/ });
    const cells = within(row).getAllByRole("cell");
    // weight, running, waiting, and 5 of the 20 busy workers
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "4",
      "5",
      "0",
      "25%",
    ]);
    // A tenant without a job steps back.
    expect(row.className).toBe("");
    expect(screen.getByRole("row", { name: /^cafe/ }).className).toBe("idle");
  });

  test("says so when the API does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    render(<App />);

    await screen.findByText("No answer from the API, trying again");
    expect(tile("Busy")).toBe("...");
    expect(screen.getByRole("cell").textContent).toBe("No tenants yet.");
  });

  // The two tools are tied together by the page: the first job of a batch
  // is the job that the status panel follows.
  test("a batch that was submitted shows its first job in the status panel", async () => {
    const fetch = api();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Live");

    await user.click(screen.getByRole("combobox", { name: "Tenant" }));
    await user.click(screen.getByRole("option", { name: "cafe" }));
    await user.clear(screen.getByLabelText("Jobs"));
    await user.type(screen.getByLabelText("Jobs"), "3");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await screen.findByText("3 jobs stored for cafe.");
    await screen.findByText("212 ms after it was submitted");
    expect(screen.getByLabelText("Job id")).toHaveProperty("value", "41");
    expect(fetch).toHaveBeenCalledWith("/api/jobs/41", expect.anything());
  });
});
