import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { TenantPicker } from "./TenantPicker.tsx";

const tenants = ["bank", "cafe", "hotel", "supermarket"];

/** The picker in a form, and the value the form would send. */
function renderPicker(options = tenants) {
  const { container } = render(
    <form>
      <TenantPicker label="Tenant" name="tenant" options={options} />
    </form>,
  );
  const input = container.querySelector<HTMLInputElement>("[name=tenant]");
  return { sent: () => input?.value };
}

const box = () => screen.getByRole("combobox", { name: "Tenant" });
const names = (elements: HTMLElement[]) => elements.map((e) => e.textContent);

describe("the tenant picker", () => {
  test("starts on the first tenant, and a click lists them all with the chosen one marked", async () => {
    const { sent } = renderPicker();
    expect(box().textContent).toBe("bank");
    expect(sent()).toBe("bank");

    await userEvent.setup().click(box());

    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(names(screen.getAllByRole("option"))).toEqual(tenants);
    expect(names(screen.getAllByRole("option", { selected: true }))).toEqual([
      "bank",
    ]);
  });

  test("a click on a tenant chooses it and closes the list", async () => {
    const { sent } = renderPicker();
    const user = userEvent.setup();

    await user.click(box());
    await user.click(screen.getByRole("option", { name: "hotel" }));

    expect(box().textContent).toBe("hotel");
    expect(sent()).toBe("hotel");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("works with the keyboard alone", async () => {
    const { sent } = renderPicker();
    const user = userEvent.setup();

    await user.tab();
    expect(document.activeElement).toBe(box());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(sent()).toBe("hotel");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Escape closes the list and keeps the choice.
    await user.keyboard("{ArrowDown}{End}{Escape}");
    expect(sent()).toBe("hotel");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("a letter jumps to the tenant that starts with it", async () => {
    const { sent } = renderPicker();
    const user = userEvent.setup();

    await user.tab();
    await user.keyboard("s");

    expect(sent()).toBe("supermarket");
  });

  test("leaving it closes the list", async () => {
    renderPicker();
    const user = userEvent.setup();

    await user.click(box());
    await user.tab();

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("without tenants it cannot be used", async () => {
    renderPicker([]);

    await userEvent.setup().click(box());

    expect(box().getAttribute("aria-disabled")).toBe("true");
    expect(box().textContent).toBe("...");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
