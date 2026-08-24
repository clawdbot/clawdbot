import { describe, expect, it, vi } from "vitest";
import { diffOwnedChange, diffOwnedRemoval } from "./owned-diff.js";

describe("diffOwnedChange", () => {
  it("evaluates manual-before-add ahead of the missing-current add", () => {
    const manual = vi.fn(() => true);
    expect(diffOwnedChange({ hasCurrent: false, manualBeforeAdd: manual })).toBe("manual");
    expect(manual).toHaveBeenCalledTimes(1);
  });

  it("adds when no current record exists and nothing blocks", () => {
    expect(diffOwnedChange({ hasCurrent: false })).toBe("add");
  });

  it("checks current-specific manual conditions before restore and equality", () => {
    const unchanged = vi.fn(() => true);
    expect(
      diffOwnedChange({
        hasCurrent: true,
        manualWhenPresent: () => true,
        restoresMissing: () => true,
        unchangedWhen: unchanged,
      }),
    ).toBe("manual");
    expect(unchanged).not.toHaveBeenCalled();
  });

  it("restores a missing record as change before checking equality", () => {
    const unchanged = vi.fn(() => true);
    expect(
      diffOwnedChange({
        hasCurrent: true,
        restoresMissing: () => true,
        unchangedWhen: unchanged,
      }),
    ).toBe("change");
    expect(unchanged).not.toHaveBeenCalled();
  });

  it("falls through from equality to change", () => {
    expect(diffOwnedChange({ hasCurrent: true, unchangedWhen: () => true })).toBe("unchanged");
    expect(diffOwnedChange({ hasCurrent: true })).toBe("change");
  });
});

describe("diffOwnedRemoval", () => {
  it("blocks on manual state and chooses release over remove otherwise", () => {
    expect(diffOwnedRemoval({ manual: true, release: true })).toBe("manual");
    expect(diffOwnedRemoval({ manual: false, release: true })).toBe("release");
    expect(diffOwnedRemoval({ manual: false })).toBe("remove");
  });
});
