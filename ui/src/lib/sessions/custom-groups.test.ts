// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  mergeSessionGroupDefaults,
  readSessionCustomGroups,
  readSidebarSectionOrder,
} from "./custom-groups.ts";

describe("session group catalog readers", () => {
  it("normalizes valid names and ignores malformed entries", () => {
    expect(
      readSessionCustomGroups({
        groups: [{ name: " Alpha " }, { name: "" }, { name: 42 }, null],
      }),
    ).toEqual([{ name: "Alpha", position: 0 }]);
    expect(readSessionCustomGroups(null)).toEqual([]);
  });

  it("keeps the catalog path-free and merges validated New Session defaults", () => {
    const groups = readSessionCustomGroups({
      groups: [
        { name: " Client ", position: 4, cwd: " /leaked/client ", worktree: false },
        { name: "Local", position: "bad", cwd: "/leaked/local", worktree: true },
      ],
    });
    expect(groups).toEqual([
      { name: "Client", position: 4 },
      { name: "Local", position: 1 },
    ]);
    expect(
      mergeSessionGroupDefaults(groups, {
        defaults: [
          { name: " Client ", cwd: " /repos/client ", worktree: true },
          { name: "Local", cwd: 42, worktree: false },
          { name: "Missing", cwd: "/repos/missing", worktree: true },
          null,
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
