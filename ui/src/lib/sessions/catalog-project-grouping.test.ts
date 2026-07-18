import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

describe("normalizeCatalogProjectGrouping", () => {
  it.each([
    ["project", "project"],
    ["none", "none"],
    [undefined, "project"],
    [null, "project"],
    ["garbage", "project"],
  ] as const)("normalizes %s to %s", (raw, expected) => {
    expect(normalizeCatalogProjectGrouping(raw)).toBe(expected);
  });
});

describe("groupCatalogSessionsByProject", () => {
  it("groups distinct cwd values and preserves first-occurrence and session order", () => {
    const result = groupCatalogSessionsByProject([
      session("b-1", "/work/bravo"),
      session("a-1", "/work/alpha"),
      session("b-2", "/work/bravo"),
    ]);

    expect(result.groups.map((group) => group.key)).toEqual(["/work/bravo", "/work/alpha"]);
    expect(result.groups.map((group) => group.label)).toEqual(["bravo", "alpha"]);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["b-1", "b-2"]);
  });

  it.each([
    ["/Users/dev/openclaw/.claude/worktrees/fix-1", "/Users/dev/openclaw"],
    ["/Users/dev/openclaw/.claude/worktrees/fix-1/ui/src", "/Users/dev/openclaw"],
    ["C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1", "C:\\Users\\dev\\openclaw"],
  ])("folds worktree cwd %s into %s", (worktreeCwd, expectedProject) => {
    const result = groupCatalogSessionsByProject([
      session("direct", expectedProject),
      session("worktree", worktreeCwd),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe(expectedProject);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["direct", "worktree"]);
  });

  it("leaves missing and blank cwd values ungrouped", () => {
    const result = groupCatalogSessionsByProject([
      session("missing"),
      session("blank", "  "),
      session("grouped", "/work/project"),
    ]);

    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  });

  it.each([
    [" /Users/dev/openclaw/// ", "/Users/dev/openclaw", "openclaw"],
    ["C:\\Users\\dev\\openclaw\\", "C:\\Users\\dev\\openclaw", "openclaw"],
  ])("normalizes %s to key %s with label %s", (cwd, expectedKey, expectedLabel) => {
    const result = groupCatalogSessionsByProject([session("one", cwd)]);

    expect(result.groups[0]).toMatchObject({
      key: expectedKey,
      label: expectedLabel,
      title: expectedKey,
    });
  });
});

function session(threadId: string, cwd?: string): SessionCatalogSession {
  return {
    threadId,
    cwd,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
  };
}
