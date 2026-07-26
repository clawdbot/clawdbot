// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readSessionCustomGroupNames, readSidebarSectionOrder } from "./custom-groups.ts";

describe("session group catalog readers", () => {
  it("normalizes valid names and ignores malformed entries", () => {
    expect(
      readSessionCustomGroupNames({
        groups: [{ name: " Alpha " }, { name: "" }, { name: 42 }, null],
      }),
    ).toEqual(["Alpha"]);
    expect(readSessionCustomGroupNames(null)).toEqual([]);
  });

  it("reads normalized section order", () => {
    expect(
      readSidebarSectionOrder({
        sectionOrder: [" work ", "", 42, "work", "category: Alpha "],
      }),
    ).toEqual(["work", "category:Alpha"]);
    expect(readSidebarSectionOrder({})).toEqual([]);
  });
});
