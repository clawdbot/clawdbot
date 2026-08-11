import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { fetchSessionLineage } from "./app-sidebar-child-session-data.ts";
import { buildSidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

function projectSidebarSession(
  row: Partial<GatewaySessionRow>,
  selfUserId?: string,
): SidebarRecentSession {
  const context = {
    basePath: "",
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "main" } },
    gateway: {
      snapshot: {
        assistantAgentId: "main",
        hello: null,
        selfUser: selfUserId ? { id: selfUserId } : undefined,
      },
    },
    sessions: {
      isPreparedWorkSession: () => false,
      pullRequestSummary: () => undefined,
    },
  } as unknown as Parameters<typeof buildSidebarSessionNavigationState>[0]["context"];
  const navigation = buildSidebarSessionNavigationState({
    context,
    routeSessionKey: "agent:main:main",
    sessionsResult: null,
    sessionsAgentId: null,
    showCron: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: false,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxCountForSessionKey: () => 0,
    hasSessionDraft: () => false,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });
  return navigation.toSidebarSession({
    key: "agent:main:draft",
    kind: "direct",
    updatedAt: 1,
    ...row,
  });
}

function projectDraftOwnership(
  row: Pick<GatewaySessionRow, "createdActor" | "sharingRole" | "visibility">,
  selfUserId?: string,
): boolean | undefined {
  return projectSidebarSession(row, selfUserId).draftOwnedBySelf;
}

describe("sidebar session live-run projection", () => {
  it("projects the durable last-message preview", () => {
    expect(
      projectSidebarSession({ lastMessagePreview: "The final reply is durable." })
        .lastMessagePreview,
    ).toBe("The final reply is durable.");
  });

  it.each([
    ["legacy running status", { status: "running" }, true],
    ["confirmed active run", { status: "running", hasActiveRun: true }, true],
    ["stale running status", { status: "running", hasActiveRun: false }, false],
    ["completed run with a stale active flag", { status: "done", hasActiveRun: true }, false],
    ["failed run with a stale active flag", { status: "failed", hasActiveRun: true }, false],
    ["archived active run", { status: "running", hasActiveRun: true, archived: true }, false],
  ] as const)("normalizes %s before publishing sidebar state", (_name, row, expected) => {
    expect(projectSidebarSession(row).hasActiveRun).toBe(expected);
  });
});

describe("sidebar draft ownership presentation", () => {
  it("keeps owner drafts at normal emphasis", () => {
    expect(
      projectDraftOwnership({
        visibility: "draft",
        sharingRole: "owner",
        createdActor: undefined,
      }),
    ).toBe(true);
  });

  it("distinguishes an admin's own draft from another person's draft", () => {
    const ownDraft = {
      visibility: "draft" as const,
      sharingRole: "admin" as const,
      createdActor: { type: "human" as const, id: "admin" },
    };
    expect(projectDraftOwnership(ownDraft, "admin")).toBe(true);
    expect(projectDraftOwnership(ownDraft, "teammate")).toBe(false);
  });

  it("never marks a shared session as an owned draft", () => {
    expect(
      projectDraftOwnership(
        {
          visibility: "shared",
          sharingRole: "owner",
          createdActor: { type: "human", id: "owner" },
        },
        "owner",
      ),
    ).toBe(false);
  });
});

describe("sidebar navigation lineage ownership", () => {
  const navigationParent: GatewaySessionRow = {
    key: "agent:main:dashboard:navigation-parent",
    kind: "direct",
    updatedAt: 1,
    childSessions: ["agent:main:subagent:child"],
  };
  const controlParent: GatewaySessionRow = {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 2,
    childSessions: ["agent:main:subagent:child"],
  };
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:child",
    kind: "direct",
    updatedAt: 3,
    parentSessionKey: navigationParent.key,
    spawnedBy: controlParent.key,
  };

  it("projects a known child exactly once under its explicit navigation parent", () => {
    const projected = projectSessionTree({
      roots: [navigationParent, controlParent],
      agentRows: [navigationParent, controlParent, child],
      childRowsByParent: {},
      loadingChildKeys: new Set(),
      knownSessionAttention: [],
      toSidebarSession: (row, isChild) =>
        ({
          key: row.key,
          isChild,
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
        }) as SidebarRecentSession,
    });

    expect(
      projected.map((row) => ({ key: row.key, children: row.children.map((entry) => entry.key) })),
    ).toEqual([
      { key: navigationParent.key, children: [child.key] },
      { key: controlParent.key, children: [] },
    ]);
  });

  it.each([
    ["legacy active child", { status: "running" }, 1, 0],
    ["stale running child", { status: "running", hasActiveRun: false }, 0, 0],
    ["failed child with a stale active flag", { status: "failed", hasActiveRun: true }, 0, 1],
  ] as const)(
    "counts normalized live runs for a %s",
    (_name, runState, runningChildCount, failedChildCount) => {
      const childRow = { ...child, ...runState };
      const projected = projectSessionTree({
        roots: [navigationParent],
        agentRows: [navigationParent, childRow],
        childRowsByParent: {},
        loadingChildKeys: new Set(),
        knownSessionAttention: [],
        toSidebarSession: (row, isChild) => ({
          ...projectSidebarSession(row),
          isChild: isChild === true,
        }),
      });

      expect(projected[0]).toMatchObject({ runningChildCount, failedChildCount });
    },
  );

  it("walks a directly opened child through its navigation parent, not its controller", async () => {
    const knownRows = new Map(
      [navigationParent, controlParent, child].map((row) => [row.key, row]),
    );
    const lineage = await fetchSessionLineage({
      client: {} as Parameters<typeof fetchSessionLineage>[0]["client"],
      sessionKey: child.key,
      knownRows,
      isCurrent: () => true,
    });

    expect(lineage).toMatchObject({
      rowsByParent: { [navigationParent.key]: [child] },
      topmostRow: navigationParent,
      lookupFailed: false,
    });
  });

  it("falls back to the control owner when persisted navigation lineage is blank", async () => {
    const childWithBlankParent = { ...child, parentSessionKey: "  \t  " };
    const projected = projectSessionTree({
      roots: [controlParent],
      agentRows: [controlParent, childWithBlankParent],
      childRowsByParent: {},
      loadingChildKeys: new Set(),
      knownSessionAttention: [],
      toSidebarSession: (row, isChild) =>
        ({
          key: row.key,
          isChild,
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
        }) as SidebarRecentSession,
    });

    expect(projected[0]?.children.map((row) => row.key)).toEqual([child.key]);

    const lineage = await fetchSessionLineage({
      client: {} as Parameters<typeof fetchSessionLineage>[0]["client"],
      sessionKey: child.key,
      knownRows: new Map([controlParent, childWithBlankParent].map((row) => [row.key, row])),
      isCurrent: () => true,
    });

    expect(lineage).toMatchObject({
      rowsByParent: { [controlParent.key]: [childWithBlankParent] },
      topmostRow: controlParent,
      lookupFailed: false,
    });
  });
});

it("keeps a prepared worktree session in Coding before canonical metadata arrives", () => {
  const key = "agent:main:new-worktree";
  const context = {
    basePath: "",
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "main" } },
    gateway: { snapshot: { assistantAgentId: "main", hello: null } },
    sessions: {
      isPreparedWorkSession: (candidate: string) => candidate === key,
      pullRequestSummary: () => undefined,
    },
  } as unknown as Parameters<typeof buildSidebarSessionNavigationState>[0]["context"];
  const navigation = buildSidebarSessionNavigationState({
    context,
    routeSessionKey: key,
    sessionsResult: {
      ts: 1,
      path: "(multiple)",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key, kind: "direct", updatedAt: 1 }],
    },
    sessionsAgentId: null,
    showCron: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: true,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxCountForSessionKey: () => 0,
    hasSessionDraft: () => false,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });

  expect(navigation.visibleSessionRows).toHaveLength(1);
  expect(navigation.toSidebarSession(navigation.visibleSessionRows[0]!).workSession).toBe(true);
});
