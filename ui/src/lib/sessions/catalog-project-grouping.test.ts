import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

describe("normalizeCatalogProjectGrouping", () => {
  it.each([
    ["project", "project"],
    ["person", "person"],
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

    expect(result.groups.map((group) => group.key)).toEqual([
      "project:/work/bravo",
      "project:/work/alpha",
    ]);
    expect(result.groups.map((group) => group.label)).toEqual(["bravo", "alpha"]);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["b-1", "b-2"]);
  });

  it("uses a custom group before the session project", () => {
    const result = groupCatalogSessionsByProject([
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
      session("project", "/work/openclaw"),
    ]);

    expect(result.groups).toMatchObject([
      {
        key: "custom:Release",
        legacySectionKey: "custom:Release",
        label: "Release",
        sessions: [{ threadId: "grouped" }],
      },
      {
        key: "project:/work/openclaw",
        legacySectionKey: "/work/openclaw",
        label: "openclaw",
        sessions: [{ threadId: "project" }],
      },
    ]);
  });

  it("sorts custom groups ahead of project groups regardless of session order", () => {
    const result = groupCatalogSessionsByProject([
      session("project", "/work/openclaw"),
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "custom:Release",
      "project:/work/openclaw",
    ]);
  });

  it("keeps custom groups separate from project paths with the same key text", () => {
    const result = groupCatalogSessionsByProject([
      { ...session("grouped"), customGroup: "repo" },
      session("project", "custom:repo"),
    ]);

    expect(result.groups).toMatchObject([
      { key: "custom:repo", sessions: [{ threadId: "grouped" }] },
      {
        key: "project:custom:repo",
        legacySectionKey: "custom:repo",
        sessions: [{ threadId: "project" }],
      },
    ]);
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
    expect(result.groups[0]?.key).toBe(`project:${expectedProject}`);
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
  ])("normalizes %s to project %s with label %s", (cwd, expectedPath, expectedLabel) => {
    const result = groupCatalogSessionsByProject([session("one", cwd)]);

    expect(result.groups[0]).toMatchObject({
      key: `project:${expectedPath}`,
      legacySectionKey: expectedPath,
      label: expectedLabel,
      title: expectedPath,
    });
  });
});

describe("groupCatalogSessionsByPerson", () => {
  it("keeps creator namespaces separate and combines canonical profile aliases", () => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("channel"),
        createdActor: {
          type: "human",
          id: "current",
          label: "Channel",
          identity: { type: "legacy", actorType: "human", source: null, id: "current" },
        },
      },
      {
        ...session("agent"),
        createdActor: {
          type: "agent",
          id: "current",
          label: "Agent",
          identity: { type: "agent", id: "current" },
        },
      },
      {
        ...session("old-profile"),
        createdActor: {
          type: "human",
          id: "former",
          label: "Person",
          identity: { type: "profile", id: "current" },
        },
      },
      {
        ...session("profile"),
        createdActor: {
          type: "human",
          id: "current",
          label: "Person",
          identity: { type: "profile", id: "current" },
        },
      },
    ]);
    expect(result.groups.map((group) => group.sessions.map((item) => item.threadId))).toEqual([
      ["agent"],
      ["channel"],
      ["old-profile", "profile"],
    ]);
  });

  it("groups attributed sessions by creator, sorted by label, and keeps session order", () => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("z-1"),
        createdActor: {
          type: "human",
          id: "profile-zoe",
          identity: { type: "profile", id: "profile-zoe" },
          label: "Zoe",
        },
      },
      {
        ...session("a-1"),
        createdActor: {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
      },
      {
        ...session("z-2"),
        createdActor: {
          type: "human",
          id: "profile-zoe",
          identity: { type: "profile", id: "profile-zoe" },
          label: "Zoe",
        },
      },
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "person:profile:profile-ada",
      "person:profile:profile-zoe",
    ]);
    expect(result.groups.map((group) => group.label)).toEqual(["Ada", "Zoe"]);
    expect(result.groups[1]?.sessions.map((item) => item.threadId)).toEqual(["z-1", "z-2"]);
    expect(result.groups[0]?.title).toBe("Created by Ada");
  });

  it.each([
    ["profile", "profile-ada", "profile-ada"],
    ["profile", "gateway-owner", "Shared owner"],
    ["agent", "gateway-owner", "gateway-owner"],
  ] as const)("labels a blank %s actor %s", (type, id, expected) => {
    const result = groupCatalogSessionsByPerson([
      {
        ...session("one"),
        createdActor: {
          type: "human",
          id,
          identity: { type, id },
          label: "  ",
        },
      },
    ]);

    expect(result.groups[0]).toMatchObject({
      key: `person:${type}:${id}`,
      legacySectionKey: `person:${id}`,
      label: expected,
    });
  });

  it("leaves unattributed sessions in the flat ungrouped tail", () => {
    const result = groupCatalogSessionsByPerson([
      session("native"),
      {
        ...session("adopted"),
        createdActor: {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
      },
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["native"]);
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
