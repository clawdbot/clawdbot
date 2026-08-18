import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { fetchSessionLineage } from "./app-sidebar-child-session-data.ts";
import {
  buildSidebarSessionNavigationState,
  compareSidebarSessionRowsByMode,
} from "./app-sidebar-session-navigation-logic.ts";
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
    showSystem: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: false,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxAttentionCountForSessionKey: () => 0,
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

function sortSidebarRows(
  rows: GatewaySessionRow[],
  sortMode: "created" | "updated" | "people",
  createdOrder: ReadonlyMap<string, number>,
  creators?: SessionsListResult["creators"],
) {
  return rows.toSorted((a, b) =>
    compareSidebarSessionRowsByMode({ a, b, sortMode, createdOrder, creators }),
  );
}

describe("sidebar session sort modes", () => {
  const row = (
    key: string,
    createdAt?: number,
    updatedAt = 1,
    creatorId?: string,
  ): GatewaySessionRow => ({
    key,
    kind: "direct",
    updatedAt,
    createdAt,
    createdActor: creatorId ? { type: "human", id: creatorId } : undefined,
    owner: creatorId ? { actor: { type: "human", id: creatorId } } : undefined,
  });

  it("sorts timestamped sessions newest-first ahead of legacy sessions", () => {
    const rows = [
      row("old-stamped", 100),
      row("legacy"),
      row("new-stamped", 200),
      row("invalid", Number.NaN),
    ];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(sortSidebarRows(rows, "created", observed).map((entry) => entry.key)).toEqual([
      "new-stamped",
      "old-stamped",
      "legacy",
      "invalid",
    ]);
  });

  it("falls back to stable observation order for equal or missing timestamps", () => {
    const rows = [
      row("missing-later"),
      row("equal-later", 100),
      row("equal-earlier", 100),
      row("missing-earlier"),
    ];
    const observed = new Map([
      ["equal-earlier", 0],
      ["equal-later", 1],
      ["missing-earlier", 2],
      ["missing-later", 3],
    ]);

    expect(sortSidebarRows(rows, "created", observed).map((entry) => entry.key)).toEqual([
      "equal-earlier",
      "equal-later",
      "missing-earlier",
      "missing-later",
    ]);
  });

  it("keeps creator ordering primary and creation time secondary in People mode", () => {
    const rows = [
      row("alex-old", 100, 1, "alex"),
      row("sam-new", 300, 1, "sam"),
      row("alex-new", 200, 1, "alex"),
    ];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(
      sortSidebarRows(rows, "people", observed, [
        { type: "human", id: "alex", label: "Alex" },
        { type: "human", id: "sam", label: "Sam" },
      ]).map((entry) => entry.key),
    ).toEqual(["alex-new", "alex-old", "sam-new"]);
  });

  it("leaves Updated mode ordered by activity", () => {
    const rows = [row("created-new", 300, 100), row("updated-new", 100, 300)];
    const observed = new Map(rows.map((entry, index) => [entry.key, index]));

    expect(sortSidebarRows(rows, "updated", observed).map((entry) => entry.key)).toEqual([
      "updated-new",
      "created-new",
    ]);
  });
});

describe("sidebar session live-run projection", () => {
  it("projects the durable last-message preview", () => {
    expect(
      projectSidebarSession({ lastMessagePreview: "The final reply is durable." })
        .lastMessagePreview,
    ).toBe("The final reply is durable.");
  });

  it.each([
    ["legacy running status", { status: "running" }, true, undefined],
    ["confirmed active run", { status: "running", hasActiveRun: true }, true, true],
    ["stale running status", { status: "running", hasActiveRun: false }, false, false],
    ["completed run with a stale active flag", { status: "done", hasActiveRun: true }, false, true],
    ["failed run with a stale active flag", { status: "failed", hasActiveRun: true }, false, true],
    ["archived active run", { status: "running", hasActiveRun: true, archived: true }, false, true],
  ] as const)(
    "normalizes %s without dropping Gateway liveness",
    (_name, row, expected, gatewayHasActiveRun) => {
      const projected = projectSidebarSession(row);
      expect(projected.hasActiveRun).toBe(expected);
      expect(projected.gatewayHasActiveRun).toBe(gatewayHasActiveRun);
    },
  );

  it("carries active cloud disk pressure into the existing sidebar badge model", () => {
    const projected = projectSidebarSession({
      placement: {
        state: "active",
        environmentId: "environment-disk",
        generation: 1,
        activeOwnerEpoch: 2,
        workspaceBaseManifestRef: "manifest-disk",
        remoteWorkspaceDir: "/workspace/disk",
        workerBundleHash: "a".repeat(64),
        createdAtMs: 10,
        updatedAtMs: 20,
        stateChangedAtMs: 15,
        diskSpace: {
          status: "critical",
          availableBytes: 50,
          totalBytes: 1_000,
          observedAtMs: 25,
        },
      },
    });

    expect(projected).toMatchObject({
      placementState: "active",
      diskSpaceStatus: "critical",
    });
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
    showSystem: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: true,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxAttentionCountForSessionKey: () => 0,
    hasSessionDraft: () => false,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });

  expect(navigation.visibleSessionRows).toHaveLength(1);
  expect(navigation.toSidebarSession(navigation.visibleSessionRows[0]!).workSession).toBe(true);
});
