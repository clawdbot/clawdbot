// Control UI tests cover app renderreaming behavior.
import { describe, expect, it } from "vitest";
import { formatDreamNextCycle } from "./app-render.ts";

describe("formatDreamNextCycle", () => {
  it("returns null for Date-invalid finite timestamps", () => {
    expect(formatDreamNextCycle(8_640_000_000_000_001)).toBeNull();
  });

  it("formats valid next-run timestamps", () => {
    expect(formatDreamNextCycle(1_700_000_000_000)).toMatch(/\d/);
  });
});
