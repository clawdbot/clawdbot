import { describe, expect, it } from "vitest";
import { reorderSessionCustomGroups } from "./custom-groups.ts";

describe("reorderSessionCustomGroups", () => {
  it("moves a group before the drop target and keeps the rest stable", () => {
    expect(reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Gamma", "Alpha")).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Alpha", "Gamma")).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
    expect(
      reorderSessionCustomGroups(["Alpha", "Beta", "Gamma"], "Alpha", "Gamma", "after"),
    ).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("dedupes and drops blank names before reordering", () => {
    expect(reorderSessionCustomGroups(["A", " A ", "", "B"], "B", "A")).toEqual(["B", "A"]);
    expect(reorderSessionCustomGroups(["A", "B"], "missing", "A")).toEqual(["A", "B"]);
  });
});
