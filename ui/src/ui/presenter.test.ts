// Control UI tests cover presenter behavior.
import { describe, expect, it } from "vitest";
import { formatNextRun } from "./presenter.ts";

describe("formatNextRun", () => {
  it("returns n/a for Date-invalid finite timestamps", () => {
    expect(formatNextRun(8_640_000_000_000_001)).toBe("n/a");
  });

  it("formats valid timestamps with weekday context", () => {
    expect(formatNextRun(0)).toBe("n/a");
    expect(formatNextRun(1_700_000_000_000)).toContain(",");
  });
});
