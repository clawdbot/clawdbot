import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { collectKnownSessionRows, fetchSessionLineage } from "./app-sidebar-child-session-data.ts";
import {
  buildSidebarSessionNavigationState,
  collectSidebarSessionRowsByKey,
  compareSidebarSessionRowsByMode,
  resolveSidebarMainSessionKey,
} from "./app-sidebar-session-navigation-logic.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

it.each([
  ["global before hello", "global", undefined, "global"],
  ["advertised global casing", "global", " GLOBAL ", "GLOBAL"],
  ["advertised key in global scope", "global", "agent:other:legacy", "agent:other:legacy"],
  ["global advertised without a roster", undefined, " GLOBAL ", "GLOBAL"],
  ["explicit per-sender scope", "per-sender", "global", "agent:ops:workspace"],
  ["per-agent key without a roster", undefined, "agent:other:legacy", "agent:ops:workspace"],
] as const)(
  "preserves the sidebar main destination for %s",
  (_name, scope, advertised, expected) => {
    expect(
      resolveSidebarMainSessionKey({
        agentId: "ops",
        agentsList: scope
          ? { defaultId: "main", mainKey: "workspace", scope, agents: [] }
          : undefined,
        hello: advertised
          ? {
              ...gatewayHelloForMethods([]),
              snapshot: {
                sessionDefaults: {
                  defaultAgentId: "main",
                  mainKey: "workspace",
                  mainSessionKey: advertised,
                },
              },
            }
          : null,
      }),
    ).toBe(expected);
  },
);

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
  owners?: SessionsListResult["owners"],
) {
  return rows.toSorted((a, b) =>
    compareSidebarSessionRowsByMode({ a, b, sortMode, createdOrder, owners }),
  );
}

describe("sidebar session sort modes", () => {
  const row = (
    key: string,
    createdAt?: number,
    updatedAt = 1,
    ownerId?: string,
  ): GatewaySessionRow => ({
    key,
    kind: "direct",
    updatedAt,
    createdAt,
    createdActor: ownerId ? { type: "human", id: ownerId } : undefined,
    owner: ownerId ? { actor: { type: "human", id: ownerId } } : undefined,
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

  it("keeps owner ordering primary and creation time secondary in People mode", () => {
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
  it("projects durable message and execution-owner facts", () => {
    expect(
      projectSidebarSession({
        lastMessagePreview: "The final reply is durable.",
        execNode: "build-mac",
      }),
    ).toMatchObject({ lastMessagePreview: "The final reply is durable.", execNode: "build-mac" });
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

  it.each([
    { name: "exact", rootKey: child.key, cachedKey: child.key },
    { name: "equivalent", rootKey: child.key.toUpperCase(), cachedKey: child.key },
    { name: "main alias", rootKey: "main", cachedKey: "agent:main:main" },
    {
      name: "case-preserving Matrix alias",
      rootKey: "Agent:Ops:Matrix:Channel:!Room:Example.Org",
      cachedKey: "agent:ops:matrix:channel:!Room:Example.Org",
    },
  ])(
    "keeps the canonical root authoritative over an $name cached child key",
    async ({ rootKey, cachedKey }) => {
      const row = (key: string, status: "available" | "offline"): GatewaySessionRow => ({
        ...child,
        key,
        placement: {
          state: "active",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          stateChangedAtMs: 1,
          environmentId: "worker:device",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest",
          remoteWorkspaceDir: "/workspace",
          runner: { kind: "device", status },
        },
      });
      const canonical = {
        ...row(rootKey, "offline"),
        parentSessionKey: undefined,
        spawnedBy: undefined,
      };
      const cached = row(cachedKey, "available");
      const hidden = row("agent:main:subagent:hidden", "available");

      const known = collectKnownSessionRows([canonical], {
        [navigationParent.key]: [cached, hidden],
      });

      expect(known.get(canonical.key)).toBe(canonical);
      expect(known.get(hidden.key)).toBe(hidden);
      expect(known).toHaveLength(2);
      const request = vi.fn();
      const lineage = await fetchSessionLineage({
        client: createTestGatewayClient(request),
        sessionKey: cached.key,
        knownRows: known,
        isCurrent: () => true,
      });
      expect(lineage?.topmostRow).toBe(canonical);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("keeps case-sensitive Matrix and Signal session identifiers distinct", () => {
    const keys = [
      "agent:ops:matrix:channel:!Room:Example.Org",
      "agent:ops:matrix:channel:!room:example.org",
      "agent:ops:signal:group:AbC123=",
      "agent:ops:signal:group:abc123=",
    ];
    const rows = keys.map((key) => ({ ...child, key }));

    expect([...collectKnownSessionRows(rows, {}).keys()]).toEqual(keys);
  });

  it("projects a known child exactly once under its explicit navigation parent", () => {
    const projected = projectSessionTree({
      roots: [navigationParent, controlParent],
      rowsByKey: collectSidebarSessionRowsByKey({
        rows: [navigationParent, controlParent, child],
        childRowsByParent: {},
      }),
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

  it("keeps exact-key insertion order while newer rows replace cached child values", () => {
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      kind: "direct",
      updatedAt: 1,
    };
    const first: GatewaySessionRow = {
      key: "agent:main:child",
      kind: "direct",
      spawnedBy: parent.key,
      label: "Old child",
    };
    const caseVariant = { ...first, key: "agent:main:Child", label: "Distinct child" };
    const sibling = { ...first, key: "agent:main:sibling", label: "Sibling" };
    const current = { ...first, label: "Current child", hasActiveRun: true };
    const rowsByKey = collectSidebarSessionRowsByKey({
      rows: [parent, current],
      childRowsByParent: {
        firstCache: [first, caseVariant],
        secondCache: [{ ...first, label: "Later cached child" }, sibling],
      },
    });
    const [tree] = projectSessionTree({
      roots: [parent],
      rowsByKey,
      loadingChildKeys: new Set(),
      knownSessionAttention: [],
      toSidebarSession: (row, isChild) => ({
        ...projectSidebarSession(row),
        isChild: isChild === true,
      }),
    });

    expect(tree?.children.map((row) => [row.key, row.label, row.hasActiveRun])).toEqual([
      [first.key, "Current child", true],
      [caseVariant.key, "Distinct child", false],
      [sibling.key, "Sibling", false],
    ]);
    expect(tree?.runningChildCount).toBe(1);
  });

  it("promotes an explicitly categorized child to a sidebar section root", () => {
    const categorizedChild = { ...child, category: "P1 issues from beta feedback" };
    const projected = projectSessionTree({
      roots: [navigationParent, categorizedChild],
      rowsByKey: collectSidebarSessionRowsByKey({
        rows: [navigationParent, categorizedChild],
        childRowsByParent: {},
      }),
      loadingChildKeys: new Set(),
      knownSessionAttention: [],
      toSidebarSession: (row, isChild) =>
        ({
          key: row.key,
          category: row.category,
          isChild,
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
        }) as SidebarRecentSession,
    });

    expect(
      projected.map((row) => ({
        key: row.key,
        category: row.category,
        isChild: row.isChild,
        children: row.children.map((entry) => entry.key),
      })),
    ).toEqual([
      { key: navigationParent.key, category: undefined, isChild: false, children: [] },
      {
        key: categorizedChild.key,
        category: categorizedChild.category,
        isChild: false,
        children: [],
      },
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
        rowsByKey: collectSidebarSessionRowsByKey({
          rows: [navigationParent, childRow],
          childRowsByParent: {},
        }),
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
      rowsByKey: collectSidebarSessionRowsByKey({
        rows: [controlParent, childWithBlankParent],
        childRowsByParent: {},
      }),
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
