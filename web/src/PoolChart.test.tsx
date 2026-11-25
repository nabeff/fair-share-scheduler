import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { addSample, emptyHistory, type History } from "./history.ts";
import { PoolChart, ticksUpTo } from "./PoolChart.tsx";

/** One sample a second with these running jobs, in a pool of 20 workers. */
function historyOf(...seconds: Record<string, number>[]): History {
  return seconds.reduce((history, running, second) => {
    const tenants = Object.entries(running).map(([id, jobs]) => ({
      id,
      weight: 1,
      running: jobs,
      waiting: 0,
    }));
    const sample = { at: second * 1000, pool: { slots: 20, tenants } };
    return addSample(history, sample);
  }, emptyHistory);
}

const columnOf = (container: HTMLElement, ago: number) =>
  container.querySelector<HTMLElement>(`[data-ago="${ago}"]`)!;

/** The lines of the readout, as text. */
const readout = () =>
  within(screen.getByRole("status"))
    .getAllByRole("listitem")
    .map((line) => line.textContent);

describe("the chart of the pool", () => {
  test("a part of a column is as high as the workers a tenant held", () => {
    const history = historyOf(
      { supermarket: 10, bank: 5 },
      { supermarket: 15, bank: 5 },
    );
    const { container } = render(<PoolChart history={history} />);

    const part = (ago: number, tenant: string) =>
      columnOf(container, ago).querySelector<HTMLElement>(
        `[data-part="${tenant}"]`,
      );
    expect(part(0, "supermarket")?.style.height).toBe("75%");
    expect(part(0, "bank")?.style.height).toBe("25%");
    expect(part(1, "supermarket")?.style.height).toBe("50%");
    // Nothing is known about the seconds before the page was opened.
    expect(columnOf(container, 2).children).toHaveLength(0);
  });

  const legend = () =>
    within(screen.getByRole("list", { name: "Legend" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  test("the legend names every tenant that is in the chart", () => {
    render(
      <PoolChart history={historyOf({ supermarket: 3, bank: 1, hotel: 0 })} />,
    );

    expect(legend()).toEqual(["Pool size", "supermarket", "bank"]);
  });

  test("a tenant that left the chart leaves the legend, and keeps its color", () => {
    // bank was first, so it has the first color. Then a minute without it.
    const seconds: Record<string, number>[] = [{ bank: 5 }];
    for (let second = 1; second <= 60; second++)
      seconds.push({ supermarket: 2 });
    const { container } = render(<PoolChart history={historyOf(...seconds)} />);

    expect(legend()).toEqual(["Pool size", "supermarket"]);
    const supermarket = columnOf(container, 0).querySelector<HTMLElement>(
      '[data-part="supermarket"]',
    );
    expect(supermarket?.style.background).toBe("var(--tenant-2)");
  });

  test("pointing at a column tells who held the workers in that second", () => {
    const history = historyOf(
      { supermarket: 10, bank: 5 },
      { supermarket: 20 },
    );
    const { container } = render(<PoolChart history={history} />);
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.pointerMove(columnOf(container, 1));
    expect(screen.getByRole("status").textContent).toContain("1 s ago");
    expect(readout()).toEqual(["10 supermarket", "5 bank", "5 idle"]);

    fireEvent.pointerMove(columnOf(container, 0));
    expect(readout()).toEqual(["20 supermarket", "0 idle"]);

    fireEvent.pointerLeave(columnOf(container, 0).parentElement!);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a tapped column stays read out after the finger is lifted", () => {
    const history = historyOf({ supermarket: 10 }, { supermarket: 20 });
    const { container } = render(<PoolChart history={history} />);
    const plot = screen.getByRole("group", { name: /Workers held/ });

    fireEvent.pointerDown(columnOf(container, 1), { pointerType: "touch" });
    fireEvent.pointerLeave(plot, { pointerType: "touch" });
    fireEvent.focus(plot); // a tap also gives the chart the focus

    expect(readout()).toEqual(["10 supermarket", "10 idle"]);

    fireEvent.blur(plot);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the arrow keys walk through the seconds", () => {
    render(
      <PoolChart history={historyOf({ supermarket: 1 }, { supermarket: 2 })} />,
    );
    const plot = screen.getByRole("group", { name: /Workers held/ });

    fireEvent.focus(plot);
    expect(readout()).toEqual(["2 supermarket", "18 idle"]);

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(readout()).toEqual(["1 supermarket", "19 idle"]);

    // There is nothing newer than now.
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(readout()).toEqual(["2 supermarket", "18 idle"]);

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  // A key that is held down sends presses faster than the chart is drawn.
  test("key presses that arrive together all count", () => {
    const seconds = [
      { supermarket: 1 },
      { supermarket: 2 },
      { supermarket: 3 },
      { supermarket: 4 },
    ];
    render(<PoolChart history={historyOf(...seconds)} />);
    const plot = screen.getByRole("group", { name: /Workers held/ });
    fireEvent.focus(plot);

    act(() => {
      for (let press = 0; press < 3; press++) {
        plot.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        );
      }
    });

    expect(screen.getByRole("status").textContent).toContain("3 s ago");
    expect(readout()).toEqual(["1 supermarket", "19 idle"]);
  });

  test("a second without a sample says so", () => {
    const { container } = render(
      <PoolChart history={historyOf({ supermarket: 1 })} />,
    );

    fireEvent.pointerMove(columnOf(container, 30));

    expect(screen.getByRole("status").textContent).toMatch(
      /30 s ago.*No sample/,
    );
  });

  test("before the first sample the chart says that there is none", () => {
    const { container } = render(<PoolChart history={emptyHistory} />);

    expect(screen.getByText("No samples yet.")).toBeTruthy();
    // No scale either: nothing is known about the size of the pool.
    expect(container.querySelector(".gridline")).toBeNull();
  });

  test("the scale has round steps, at most five", () => {
    expect(ticksUpTo(4)).toEqual([1, 2, 3, 4]);
    expect(ticksUpTo(20)).toEqual([5, 10, 15, 20]);
    expect(ticksUpTo(18)).toEqual([5, 10, 15]);
    expect(ticksUpTo(500)).toEqual([100, 200, 300, 400, 500]);
  });
});
