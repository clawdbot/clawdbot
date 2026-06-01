import { describe, expect, it } from "vitest";
import { resolveTargetIdFromTabs } from "./target-id.js";

const tabs = [
  {
    targetId: "ABCDEF123456",
    suggestedTargetId: "docs",
    tabId: "t1",
    label: "docs",
  },
  {
    targetId: "ABC999",
    suggestedTargetId: "t2",
    tabId: "t2",
  },
];

describe("resolveTargetIdFromTabs", () => {
  it("resolves friendly tab references before falling back to raw target prefixes", () => {
    expect(resolveTargetIdFromTabs("docs", tabs)).toEqual({
      ok: true,
      targetId: "ABCDEF123456",
    });
    expect(resolveTargetIdFromTabs("t2", tabs)).toEqual({
      ok: true,
      targetId: "ABC999",
    });
    expect(resolveTargetIdFromTabs("ABCDEF123456", tabs)).toEqual({
      ok: true,
      targetId: "ABCDEF123456",
    });
  });

  it("keeps unique raw target-id prefixes as compatibility input", () => {
    expect(resolveTargetIdFromTabs("ABCDEF", tabs)).toEqual({
      ok: true,
      targetId: "ABCDEF123456",
    });
  });

  it("rejects ambiguous raw target-id prefixes", () => {
    expect(resolveTargetIdFromTabs("ABC", tabs)).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["ABCDEF123456", "ABC999"],
    });
  });
});
