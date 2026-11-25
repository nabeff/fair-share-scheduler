import { describe, expect, test } from "vitest";
import { count, duration, list, percent } from "./format.ts";

describe("numbers as text", () => {
  test("a count gets separators", () => {
    expect(count(7)).toBe("7");
    expect(count(99280)).toBe("99,280");
  });

  test("a share is a whole percentage", () => {
    expect(percent(4 / 7)).toBe("57%");
    expect(percent(0)).toBe("0%");
    expect(percent(1)).toBe("100%");
  });

  test("a duration uses the unit that fits", () => {
    expect(duration(0)).toBe("0 ms");
    expect(duration(212)).toBe("212 ms");
    expect(duration(999.6)).toBe("1.0 s");
    expect(duration(2215)).toBe("2.2 s");
    expect(duration(59_949)).toBe("59.9 s");
    expect(duration(60_000)).toBe("1 min 0 s");
    expect(duration(192_400)).toBe("3 min 12 s");
  });
});

test("names are joined the way a sentence does it", () => {
  expect(list(["bank"])).toBe("bank");
  expect(list(["bank", "hotel"])).toBe("bank and hotel");
  expect(list(["bank", "hotel", "school"])).toBe("bank, hotel and school");
});
