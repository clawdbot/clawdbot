// Session store pruning tests cover pruning decisions and retention ordering.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveLegacySessionStore as saveSessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  collectSessionMaintenancePreserveKeys,
  registerSessionMaintenancePreserveKeysProvider,
} from "./store-maintenance-preserve.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  pruneStaleModelRunEntries,
  resolveMaintenanceConfigFromInput,
  resolveQuotaSuspensionEntryMaintenance,
  shouldPreserveMaintenanceEntry,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

function isGatewayModelRunSessionKey(sessionKey: string): boolean {
  const store = makeStore([[sessionKey, makeEntry(Date.now() - 10 * DAY_MS)]]);
  return pruneStaleModelRunEntries(store, DAY_MS) === 1;
}

function isProtectedSessionMaintenanceEntry(key: string, entry: SessionEntry | undefined): boolean {
  return shouldPreserveMaintenanceEntry({ key, entry });
}

function resolveSessionEntryMaintenanceHighWater(maxEntries: number): number {
  let entryCount = 0;
  while (!shouldRunSessionEntryMaintenance({ entryCount, maxEntries })) {
    entryCount += 1;
  }
  return entryCount;
}

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    removeRemovedSessionTrajectoryArtifacts: async () => {},
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("fresh");
  });

  it("preserves durable external conversation entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C123:thread:1710000000.000100", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C999", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123", { ...makeEntry(now - 31 * DAY_MS), chatType: "group" }],
      ["agent:main:discord:channel:ops", { ...makeEntry(now - 31 * DAY_MS), chatType: "channel" }],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("agent:main:slack:channel:C123:thread:1710000000.000100");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).toHaveProperty("agent:main:slack:channel:C999");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123");
    expect(store).toHaveProperty("agent:main:discord:channel:ops");
  });

  it("preserves model-locked harness sessions even when stale", () => {
    const now = Date.now();
    const lockedKey = "agent:main:harness-owned:locked";
    const store = makeStore([
      [lockedKey, { ...makeEntry(now - 31 * DAY_MS), modelSelectionLocked: true }],
      ["old", makeEntry(now - 31 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store).toHaveProperty(lockedKey);
    expect(store.old).toBeUndefined();
  });

  it("preserves archived entries until they are unarchived", () => {
    const now = Date.now();
    const store = makeStore([
      ["archived", { ...makeEntry(now - 31 * DAY_MS), archivedAt: now - DAY_MS }],
    ]);

    expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(0);
    expect(store).toHaveProperty("archived");

    delete store.archived?.archivedAt;
    expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(1);
    expect(store.archived).toBeUndefined();
  });
});

describe("resolveQuotaSuspensionEntryMaintenance", () => {
  it("returns an entry-scoped patch when a suspended session should resume", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: {
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "resuming",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      resumed: { laneId: "main" },
      cleared: false,
    });
  });

  it("returns an entry-scoped cleanup patch after the resume window expires", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 61_000,
          expectedResumeBy: now - 31_000,
          state: "active",
          reason: "circuit_open",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: { quotaSuspension: undefined },
      cleared: true,
    });
  });
});

describe("applyFileBackedSessionStoreMaintenance", () => {
  it("preserves the active session and cleans artifacts using the final referenced session set", async () => {
    const now = Date.now();
    const store = makeStore([
      ["stale", { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS }],
      [
        "stale-shared",
        {
          sessionId: "shared-session",
          updatedAt: now - 30 * DAY_MS,
        },
      ],
      ["fresh-shared", { sessionId: "shared-session", updatedAt: now }],
      ["active", { sessionId: "active-session", updatedAt: now - 30 * DAY_MS }],
    ]);
    const archiveCalls: Array<{
      removedSessionFiles: Array<[string, string | undefined]>;
      referencedSessionIds: Set<string>;
    }> = [];
    let trajectoryCleanupReferencedIds: Set<string> | undefined;

    const result = await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      activeSessionKey: "active",
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 500,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async (params) => {
          archiveCalls.push({
            removedSessionFiles: [...params.removedSessionFiles],
            referencedSessionIds: new Set(params.referencedSessionIds),
          });
          return new Set();
        },
        removeRemovedSessionTrajectoryArtifacts: async (params) => {
          trajectoryCleanupReferencedIds = new Set(params.referencedSessionIds);
        },
        cleanupArchivedSessionTranscripts: async () => {},
      },
    });

    expect(result.changedStore).toBe(true);
    expect(store.stale).toBeUndefined();
    expect(store["stale-shared"]).toBeUndefined();
    expect(store).toHaveProperty("fresh-shared");
    expect(store).toHaveProperty("active");
    expect(archiveCalls).toEqual([
      {
        removedSessionFiles: [
          ["stale-session", undefined],
          ["shared-session", undefined],
        ],
        referencedSessionIds: new Set(["shared-session", "active-session"]),
      },
    ]);
    expect(trajectoryCleanupReferencedIds).toEqual(new Set(["shared-session", "active-session"]));
  });

  it("reports archive retention failure without aborting file-backed maintenance", async () => {
    const now = Date.now();
    const store = makeStore([
      ["stale", { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS }],
      ["fresh", { sessionId: "fresh-session", updatedAt: now }],
    ]);
    const cleanupError = new Error("archive cleanup denied");
    const warn = vi.fn();
    const onMaintenanceApplied = vi.fn();

    const result = await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 500,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: 0,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      onMaintenanceApplied,
      log: { warn, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set(),
        removeRemovedSessionTrajectoryArtifacts: async () => {},
        cleanupArchivedSessionTranscripts: async () => {
          throw cleanupError;
        },
      },
    });

    expect(result.changedStore).toBe(true);
    expect(store.stale).toBeUndefined();
    expect(store).toHaveProperty("fresh");
    expect(onMaintenanceApplied).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("session transcript archive retention cleanup failed", {
      error: String(cleanupError),
    });
  });

  it("forced cleanup prunes stale model-run probes before the cap evicts real sessions", async () => {
    const now = Date.now();
    const staleProbe = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174099";
    const store: Record<string, SessionEntry> = {
      [staleProbe]: makeEntry(now - 2 * DAY_MS),
    };
    for (let i = 0; i < 50; i++) {
      store[`agent:main:explicit:real-${i}`] = makeEntry(now - 3 * DAY_MS);
    }
    let report: { modelRunPruned: number; pruned: number; capped: number } | undefined;

    const result = await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 50,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      maintenanceOverride: { mode: "enforce" },
      onMaintenanceApplied: (applied) => {
        report = {
          modelRunPruned: applied.modelRunPruned,
          pruned: applied.pruned,
          capped: applied.capped,
        };
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set(),
        removeRemovedSessionTrajectoryArtifacts: async () => {},
        cleanupArchivedSessionTranscripts: async () => {},
      },
    });

    expect(result.changedStore).toBe(true);
    expect(report?.modelRunPruned).toBe(1);
    expect(report?.capped).toBe(0);
    expect(store[staleProbe]).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(store).toHaveProperty(`agent:main:explicit:real-${i}`);
    }
  });

  it.each([
    {
      name: "preserves every active admission instead of only the writer session",
      storeName: "active-admissions",
      preserved: [
        ["agent:main:cron:job:run:active", "active-session"],
        ["writer", "writer-session"],
      ],
      identities: ["agent:main:cron:job:run:active", "active-session"],
      activeSessionKey: "writer",
    },
    {
      name: "preserves every store alias backed by an active session id",
      storeName: "active-aliases",
      preserved: [
        ["agent:main:cron:job:run:active", "active-alias-session"],
        ["agent:main:cron:job:run:active:thread:reply", "active-alias-session"],
      ],
      identities: ["active-alias-session"],
      activeSessionKey: undefined,
    },
    {
      name: "preserves a raw legacy store key matched by a canonical admission identity",
      storeName: "active-legacy-key",
      preserved: [["Agent:Main:Subagent:CHILD", "active-legacy-session"]],
      identities: ["agent:main:subagent:child"],
      activeSessionKey: undefined,
    },
  ] as const)("$name", async ({ storeName, preserved, identities, activeSessionKey }) => {
    const now = Date.now();
    const storePath = `/tmp/openclaw-sessions/${storeName}.json`;
    const store = makeStore([
      ...preserved.map(([key, sessionId], index): [string, SessionEntry] => [
        key,
        { sessionId, updatedAt: now - preserved.length - 1 + index },
      ]),
      ["removable", { sessionId: "removable-session", updatedAt: now - 1 }],
    ]);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [...identities],
      assertAllowed: () => {},
    });

    try {
      await applyFileBackedSessionStoreMaintenance({
        storePath,
        store,
        activeSessionKey,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          maxEntries: 1,
          modelRunPruneAfterMs: DAY_MS,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      for (const [key] of preserved) {
        expect(store).toHaveProperty(key);
      }
      expect(store.removable).toBeUndefined();
    } finally {
      admission.release();
    }
  });

  it("scopes active preservation by store and releases rows back to maintenance", async () => {
    const now = Date.now();
    const activeStorePath = "/tmp/openclaw-sessions/active-store.json";
    const maintainedStorePath = "/tmp/openclaw-sessions/maintained-store.json";
    const activeSessionId = "shared-session-id";
    const admission = await beginSessionWorkAdmission({
      scope: activeStorePath,
      identities: [activeSessionId],
      assertAllowed: () => {},
    });
    const maintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 30 * DAY_MS,
      maxEntries: 1,
      modelRunPruneAfterMs: DAY_MS,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

    try {
      const otherStore = makeStore([
        ["old", { sessionId: activeSessionId, updatedAt: now - 31 * DAY_MS }],
        ["new", { sessionId: "new-session", updatedAt: now - 1 }],
      ]);
      await applyFileBackedSessionStoreMaintenance({
        storePath: maintainedStorePath,
        store: otherStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(otherStore.old).toBeUndefined();

      const activeStore = makeStore([
        ["old", { sessionId: activeSessionId, updatedAt: now - 31 * DAY_MS }],
        ["new", { sessionId: "new-session", updatedAt: now - 1 }],
      ]);
      await applyFileBackedSessionStoreMaintenance({
        storePath: activeStorePath,
        store: activeStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(activeStore).toHaveProperty("old");

      admission.release();
      await applyFileBackedSessionStoreMaintenance({
        storePath: activeStorePath,
        store: activeStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(activeStore.old).toBeUndefined();
    } finally {
      admission.release();
    }
  });
});

describe("pruneStaleModelRunEntries", () => {
  it("removes only stale generated gateway model-run sessions", () => {
    const now = Date.now();
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174001";
    const store = makeStore([
      [staleModelRun, makeEntry(now - 25 * 60 * 60 * 1000)],
      [recentModelRun, makeEntry(now)],
      ["agent:main:explicit:model-run-not-a-uuid", makeEntry(now - 10 * DAY_MS)],
      [
        "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174002",
        makeEntry(now - 10 * DAY_MS),
      ],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 10 * DAY_MS)],
      ["agent:main:cron:job:run:123", makeEntry(now - 10 * DAY_MS)],
    ]);

    const pruned = pruneStaleModelRunEntries(store, DAY_MS);

    expect(pruned).toBe(1);
    expect(store[staleModelRun]).toBeUndefined();
    expect(store).toHaveProperty(recentModelRun);
    expect(store).toHaveProperty("agent:main:explicit:model-run-not-a-uuid");
    expect(store).toHaveProperty(
      "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174002",
    );
    expect(store).toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).toHaveProperty("agent:main:cron:job:run:123");
  });

  it("honors preserve keys and disabled retention", () => {
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const store = makeStore([[staleModelRun, makeEntry(Date.now() - 10 * DAY_MS)]]);

    expect(
      pruneStaleModelRunEntries(store, DAY_MS, { preserveKeys: new Set([staleModelRun]) }),
    ).toBe(0);
    expect(store).toHaveProperty(staleModelRun);
    expect(pruneStaleModelRunEntries(store, null)).toBe(0);
    expect(store).toHaveProperty(staleModelRun);
  });

  it("preserves model-locked harness sessions from model-run pruning", () => {
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const store = makeStore([
      [staleModelRun, { ...makeEntry(Date.now() - 10 * DAY_MS), modelSelectionLocked: true }],
    ]);

    expect(pruneStaleModelRunEntries(store, DAY_MS)).toBe(0);
    expect(store).toHaveProperty(staleModelRun);
  });

  it("matches only explicit model-run uuid session keys", () => {
    expect(
      isGatewayModelRunSessionKey(
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(true);
    expect(isGatewayModelRunSessionKey("agent:main:explicit:model-run-not-a-uuid")).toBe(false);
    expect(
      isGatewayModelRunSessionKey(
        "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(false);
  });

  it("rejects non-canonical session keys that do not parse as agent-scoped", () => {
    // Unscoped: missing `agent:<id>:` prefix — parseAgentSessionKey returns null.
    expect(
      isGatewayModelRunSessionKey("explicit:model-run-123e4567-e89b-12d3-a456-426614174000"),
    ).toBe(false);
    // Empty agent id segment: not a canonical `agent:<id>:` scoped key.
    expect(
      isGatewayModelRunSessionKey("agent::explicit:model-run-123e4567-e89b-12d3-a456-426614174000"),
    ).toBe(false);
    // Extra colon segment between agent id and `explicit:` — rest starts
    // with `extra:` and fails the predicate's regex.
    expect(
      isGatewayModelRunSessionKey(
        "agent:main:extra:explicit:model-run-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(false);
    // Whitespace-padded keys are non-canonical even though parseAgentSessionKey
    // trims before normalizing; the predicate intentionally checks the original
    // key shape before accepting a model-run key.
    expect(
      isGatewayModelRunSessionKey(
        "  agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(false);
    expect(
      isGatewayModelRunSessionKey(
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000  ",
      ),
    ).toBe(false);
  });

  it("matches canonical keys whose agent id begins with model-run-", () => {
    // Guards against an over-tight fix that confuses the agent id segment
    // with the `explicit:model-run-<uuid>` rest segment.
    expect(
      isGatewayModelRunSessionKey(
        "agent:model-run-foo:explicit:model-run-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(true);
  });

  it("preserves case-insensitive matching for canonical keys", () => {
    // normalizeLowercaseStringOrEmpty + parseAgentSessionKey's normalization
    // lower-case everything outside opaque peer IDs, so a mixed-case
    // canonical key still matches.
    expect(
      isGatewayModelRunSessionKey(
        "agent:Main:Explicit:Model-Run-123E4567-E89B-12D3-A456-426614174000",
      ),
    ).toBe(true);
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const store = makeStore([
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store).toHaveProperty("newest");
    expect(store).toHaveProperty("recent");
    expect(store).toHaveProperty("mid");
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("preserves durable external conversation entries when capping", () => {
    const now = Date.now();
    const threadKey = "agent:main:discord:channel:123456:thread:987654";
    const store = makeStore([
      [threadKey, makeEntry(now - 5 * DAY_MS)],
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["recent", makeEntry(now - DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store).toHaveProperty(threadKey);
    expect(store).toHaveProperty("newest");
    expect(store).toHaveProperty("recent");
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("never evicts the agent primary main session even when protected entries fill the cap (#112637)", () => {
    const now = Date.now();
    const mainKey = "agent:main:main";
    // `main` is the oldest entry, so pre-fix it was the first unprotected eviction target once
    // protected thread entries (>= maxEntries) left zero removable budget.
    const store = makeStore([
      [mainKey, makeEntry(now - 10 * DAY_MS)],
      ["agent:main:slack:channel:C1:thread:1", makeEntry(now - 3 * DAY_MS)],
      ["agent:main:slack:channel:C2:thread:2", makeEntry(now - 2 * DAY_MS)],
      ["agent:main:slack:channel:C3:thread:3", makeEntry(now - DAY_MS)],
    ]);

    const evicted = capEntryCount(store, 2);

    // Every entry is now protected (main + threads), so nothing is evicted and `main` survives.
    expect(store).toHaveProperty(mainKey);
    expect(evicted).toBe(0);
    expect(Object.keys(store)).toHaveLength(4);
  });

  it("preserves model-locked harness sessions when capping", () => {
    const now = Date.now();
    const lockedKey = "agent:main:harness-owned:locked";
    const store = makeStore([
      [lockedKey, { ...makeEntry(now - 10 * DAY_MS), modelSelectionLocked: true }],
      ["recent", makeEntry(now)],
      ["old", makeEntry(now - DAY_MS)],
    ]);

    const evicted = capEntryCount(store, 2);

    expect(evicted).toBe(1);
    expect(store).toHaveProperty(lockedKey);
    expect(store).toHaveProperty("recent");
    expect(store.old).toBeUndefined();
  });

  it("preserves archived sessions when capping", () => {
    const now = Date.now();
    const store = makeStore([
      ["archived", { ...makeEntry(now - 10 * DAY_MS), archivedAt: now - 5 * DAY_MS }],
      ["recent", makeEntry(now)],
      ["old", makeEntry(now - DAY_MS)],
    ]);

    expect(capEntryCount(store, 2)).toBe(1);
    expect(store).toHaveProperty("archived");
    expect(store).toHaveProperty("recent");
    expect(store.old).toBeUndefined();
  });

  it("preserves runtime-provided pending subagent sessions when capping", () => {
    const now = Date.now();
    const childKey = "agent:main:subagent:child";
    const store = makeStore([
      [childKey, { ...makeEntry(now - 10 * DAY_MS), spawnedBy: "agent:main:slack:direct:U1" }],
      ["recent-1", makeEntry(now)],
      ["recent-2", makeEntry(now - 1)],
      ["old", makeEntry(now - 2)],
    ]);
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [childKey]);

    try {
      const evicted = capEntryCount(store, 2, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(2);
      expect(Object.keys(store)).toHaveLength(2);
      expect(store).toHaveProperty(childKey);
      expect(store).toHaveProperty("recent-1");
      expect(store["recent-2"]).toBeUndefined();
      expect(store.old).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("normalizes runtime-provided preserve keys to match lowercased store keys", () => {
    const now = Date.now();
    const childKey = "agent:main:subagent:child";
    const store = makeStore([
      [childKey, { ...makeEntry(now - 10 * DAY_MS), spawnedBy: "agent:main:slack:direct:U1" }],
      ["recent-1", makeEntry(now)],
      ["old", makeEntry(now - 1)],
    ]);
    // Provider returns the key in mixed case + with surrounding whitespace;
    // normalization must match the lowercased store key during maintenance.
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [
      "  Agent:Main:Subagent:CHILD  ",
    ]);

    try {
      const evicted = capEntryCount(store, 2, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(1);
      expect(Object.keys(store)).toHaveLength(2);
      expect(store).toHaveProperty(childKey);
      expect(store).toHaveProperty("recent-1");
      expect(store.old).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("can temporarily exceed the cap when every candidate is runtime-protected", () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:subagent:child-a", makeEntry(now - 2)],
      ["agent:main:subagent:child-b", makeEntry(now - 1)],
    ]);
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => Object.keys(store));

    try {
      const evicted = capEntryCount(store, 1, {
        preserveKeys: collectSessionMaintenancePreserveKeys(),
      });

      expect(evicted).toBe(0);
      expect(Object.keys(store)).toHaveLength(2);
    } finally {
      unregister();
    }
  });
});

describe("enforceSessionDiskBudget", () => {
  it("preserves archived sessions under disk pressure", async () => {
    const dir = await fixtureSuite.createCaseDir("archived-disk-budget");
    const storePath = path.join(dir, "sessions.json");
    const archivedKey = "agent:main:archived";
    const removableKey = "agent:main:subagent:old-worker";
    const activeKey = "agent:main:main";
    const store: Record<string, SessionEntry> = {
      [archivedKey]: {
        sessionId: "archived",
        updatedAt: 1,
        archivedAt: 2,
        displayName: "a".repeat(2_000),
      },
      [removableKey]: {
        sessionId: "removable",
        updatedAt: 2,
        displayName: "r".repeat(2_000),
      },
      [activeKey]: { sessionId: "active", updatedAt: 3 },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      activeSessionKey: activeKey,
      maintenance: { maxDiskBytes: 1_000, highWaterBytes: 500 },
      warnOnly: false,
    });

    expect(store).toHaveProperty(archivedKey);
    expect(store[removableKey]).toBeUndefined();
    expect(store).toHaveProperty(activeKey);
    expect(result?.removedEntries).toBe(1);
  });
});

describe("isProtectedSessionMaintenanceEntry", () => {
  it.each([
    ["agent:main:main", true],
    ["agent:worker:main", true],
    ["global", true],
    ["agent:main:opaque", false],
  ])("classifies primary session key %s as protected=%s", (key, expected) => {
    expect(isProtectedSessionMaintenanceEntry(key, makeEntry(Date.now()))).toBe(expected);
  });

  it("treats generated ACP bridge sessions as disposable", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:acp-bridge:session-1", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
  });

  it("does not protect synthetic sessions just because they carry group metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:subagent:worker", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:cron:job:run:123", {
        ...makeEntry(Date.now()),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "group:test" },
          origin: { chatType: "group" },
        }),
      }),
    ).toBe(false);
  });

  it("protects metadata-less Telegram topic keys without treating every :topic: id as a thread", () => {
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:telegram:group:-100123:topic:77",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:opaque:topic:om_topic_root:sender:ou_topic_user",
        makeEntry(Date.now()),
      ),
    ).toBe(false);
  });

  it("protects metadata-less channel session keys and channel chat metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:slack:channel:C123", makeEntry(Date.now())),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:custom:channel:room-one:with:colon",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:opaque", {
        ...makeEntry(Date.now()),
        chatType: "channel",
      }),
    ).toBe(true);
  });
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("defaults to enforcing session maintenance", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.mode).toBe("enforce");
  });

  it("defaults gateway model-run probes to fixed 24h retention", () => {
    expect(resolveMaintenanceConfigFromInput().modelRunPruneAfterMs).toBe(DAY_MS);
  });

  it("keeps archived transcripts by default and bounds growth with a disk budget", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.resetArchiveRetentionMs).toBeNull();
    expect(maintenance.maxDiskBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(maintenance.highWaterBytes).toBe(Math.floor(10 * 1024 * 1024 * 1024 * 0.8));
  });

  it("honors explicit archive retention and disk budget opt-outs", () => {
    const maintenance = resolveMaintenanceConfigFromInput({
      resetArchiveRetention: "7d",
      maxDiskBytes: false,
    });

    expect(maintenance.resetArchiveRetentionMs).toBe(7 * DAY_MS);
    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("disables the disk budget when an explicit maxDiskBytes fails to parse", () => {
    const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: "lots" });

    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("disables the disk budget when maxDiskBytes is 0", () => {
    const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: 0 });

    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("disables the disk budget when maxDiskBytes is the string '0'", () => {
    const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: "0" });

    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("retains session history when a zero maxDiskBytes disables the budget", async () => {
    await withTestDir({ prefix: "openclaw-zero-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const transcriptPath = path.join(dir, "old-session.jsonl");
      await fs.writeFile(transcriptPath, JSON.stringify({ role: "user", content: "hello" }));
      const store: Record<string, SessionEntry> = {
        "agent:main:subagent:old-worker": {
          sessionId: "old-session",
          updatedAt: 1,
          transcriptPath,
        },
      };
      await saveSessionStore(storePath, store, { skipMaintenance: true });

      const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: 0 });
      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: maintenance.maxDiskBytes,
          highWaterBytes: maintenance.highWaterBytes,
        },
        warnOnly: false,
      });

      expect(maintenance.maxDiskBytes).toBeNull();
      expect(maintenance.highWaterBytes).toBeNull();
      expect(result).toBeNull();
      await expect(fs.access(transcriptPath)).resolves.toBeUndefined();
    });
  });

  it("force-gates the unset model-run prune default to the cap-eviction threshold", () => {
    const defaultMaintenance = resolveMaintenanceConfigFromInput({ maxEntries: 50 });
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 60 })).toBe(false);
    expect(
      shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 60, force: true }),
    ).toBe(true);
    expect(
      shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 50, force: true }),
    ).toBe(false);
  });

  it("batches normal entry-count maintenance for production-sized caps", () => {
    expect(resolveSessionEntryMaintenanceHighWater(2)).toBe(3);
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(resolveSessionEntryMaintenanceHighWater(500)).toBe(550);
  });
});

describe("getActiveSessionMaintenanceWarning", () => {
  it("warns when the active session is outside the retained recent entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["newest", makeEntry(now)],
      ["recent", makeEntry(now - 1)],
      ["active", makeEntry(now - 2)],
      ["old", makeEntry(now - 3)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 2,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
    expect(warning?.wouldPrune).toBe(false);
  });

  it("preserves insertion order tie behavior from stable sorting", () => {
    const now = Date.now();
    const store = makeStore([
      ["same-before", makeEntry(now)],
      ["active", makeEntry(now)],
      ["same-after", makeEntry(now)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 1,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
  });
});
