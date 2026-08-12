// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  readSessionCustomGroupNames,
  readSessionCustomGroups,
  readSidebarSectionOrder,
} from "./custom-groups.ts";

describe("session group catalog readers", () => {
  it("normalizes valid names and ignores malformed entries", () => {
    expect(
      readSessionCustomGroupNames({
        groups: [{ name: " Alpha " }, { name: "" }, { name: 42 }, null],
      }),
    ).toEqual(["Alpha"]);
    expect(readSessionCustomGroupNames(null)).toEqual([]);
  });

  it("reads New Session defaults without trusting malformed fields", () => {
    expect(
      readSessionCustomGroups({
        groups: [
          { name: " Client ", position: 4, cwd: " /repos/client ", worktree: true },
          { name: "Local", position: "bad", cwd: 42, worktree: false },
        ],
      }),
    ).toEqual([
      { name: "Client", position: 4, cwd: "/repos/client", worktree: true },
      { name: "Local", position: 1, worktree: false },
    ]);
  });

  it("reads normalized section order", () => {
    expect(
      readSidebarSectionOrder({
        sectionOrder: [
          " work ",
          "",
          42,
          "work",
          "category: Alpha ",
          " catalog: codex ",
          "catalog:",
        ],
      }),
    ).toEqual(["work", "category:Alpha", "catalog:codex"]);
    expect(readSidebarSectionOrder({})).toEqual([]);
  });
});
