import { describe, expect, it } from "vitest";
import { formatFastModeLabel } from "./status-labels.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast");
  });

  it("hides fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBeNull();
  });
});
