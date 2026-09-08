import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifactsCore,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { planSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { runByteLimitedArchiveCleanupFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
  afterMaterialize: undefined as (() => void) | undefined,
  onMaterialize: undefined as ((sessionIds: string[]) => void) | undefined,
}));
const archivePublicationHook = vi.hoisted(() => ({
  failNext: undefined as Error | undefined,
}));

// Place test mutations after the real Worker finishes but before cleanup opens
// its final transaction, without relying on cross-isolate filesystem timing.
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      archiveMaterializationHook.onMaterialize?.(args[0].map((plan) => plan.sessionId));
      const result = await actual.materializeSessionStateDeletePlans(...args);
      archiveMaterializationHook.afterMaterialize?.();
      return result;
    },
  };
});

vi.mock("./session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-store.js")>();
  return {
    ...actual,
    publishSessionStateArchives: async (
      ...args: Parameters<typeof actual.publishSessionStateArchives>
    ) => {
      const error = archivePublicationHook.failNext;
      archivePublicationHook.failNext = undefined;
      if (error) {
        throw error;
      }
      return await actual.publishSessionStateArchives(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite lifecycle cleanup races", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-cleanup-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    archiveMaterializationHook.beforeMaterialize = undefined;
    archiveMaterializationHook.afterMaterialize = undefined;
    archiveMaterializationHook.onMaterialize = undefined;
    archivePublicationHook.failNext = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("ages transcript-free session rows before reclaiming them", async () => {
    const now = Date.now();
    const activeSessionKey = "agent:main:cleanup-race-active";
    const orphanSessionKey = "agent:main:cleanup-race-orphan";
    await replaceSessionEntry(
      { sessionKey: activeSessionKey, storePath },
      { sessionId: "active-without-transcript", updatedAt: now },
    );
    await replaceSessionEntry(
      { sessionKey: orphanSessionKey, storePath },
      { sessionId: "orphan-without-transcript", updatedAt: now - 600_000 },
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });

    expect(loadSessionEntry({ sessionKey: activeSessionKey, storePath })).toMatchObject({
      sessionId: "active-without-transcript",
    });
    expect(loadSessionEntry({ sessionKey: orphanSessionKey, storePath })).toBeUndefined();
  });

  it("preserves newly admitted sessions reusing an older transcript", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cleanup-race-reused";
    const sessionId = "reused-active-session";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: now });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        runId: "cleanup-race-marker-reused",
        timestamp: new Date(now - 600_000).toISOString(),
        type: "metadata",
      },
    ]);

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
  });

  it("preserves foreign plugin ownership while reclaiming owned and legacy rows", async () => {
    const now = Date.now();
    const staleUpdatedAt = now - 600_000;
    const ownedKey = "agent:main:cleanup-race-owned";
    const legacyKey = "agent:main:cleanup-race-legacy";
    const foreignKey = "agent:main:cleanup-race-foreign";
    await replaceSessionEntry(
      { sessionKey: ownedKey, storePath },
      { sessionId: "owned-session", updatedAt: staleUpdatedAt, pluginOwnerId: "memory-core" },
    );
    await replaceSessionEntry(
      { sessionKey: legacyKey, storePath },
      { sessionId: "legacy-session", updatedAt: staleUpdatedAt },
    );
    await replaceSessionEntry(
      { sessionKey: foreignKey, storePath },
      { sessionId: "foreign-session", updatedAt: staleUpdatedAt, pluginOwnerId: "other-plugin" },
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        pluginOwnerId: "memory-core",
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 2, archivedTranscriptArtifacts: 0 });

    expect(loadSessionEntry({ sessionKey: ownedKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: legacyKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: foreignKey, storePath })).toMatchObject({
      pluginOwnerId: "other-plugin",
    });
  });

  it("keeps another agent's current and historical sessions in a shared SQLite store", async () => {
    const now = Date.now();
    const staleUpdatedAt = now - 600_000;
    const sharedStorePath = path.join(tempDir, "shared.sqlite");
    const mainKey = "agent:main:cleanup-race-main";
    const researcherKey = "agent:researcher:cleanup-race-researcher";
    const researcherHistoryKey = "agent:researcher:normal-session";
    const researcherHistoryId = "researcher-orphaned-history";

    await replaceSessionEntry(
      { agentId: "main", sessionKey: mainKey, storePath: sharedStorePath },
      { sessionId: "main-orphan", updatedAt: staleUpdatedAt, pluginOwnerId: "memory-core" },
    );
    await replaceSessionEntry(
      { agentId: "researcher", sessionKey: researcherKey, storePath: sharedStorePath },
      { sessionId: "researcher-orphan", updatedAt: staleUpdatedAt, pluginOwnerId: "memory-core" },
    );
    await replaceSessionEntry(
      { agentId: "researcher", sessionKey: researcherHistoryKey, storePath: sharedStorePath },
      { sessionId: researcherHistoryId, updatedAt: staleUpdatedAt },
    );
    const researcherHistoryEvent = {
      runId: "cleanup-race-marker-researcher-history",
      timestamp: new Date(staleUpdatedAt).toISOString(),
      type: "metadata",
    };
    await replaceTranscriptEvents(
      {
        agentId: "researcher",
        sessionKey: researcherHistoryKey,
        sessionId: researcherHistoryId,
        storePath: sharedStorePath,
      },
      [researcherHistoryEvent],
    );
    await replaceSessionEntry(
      { agentId: "researcher", sessionKey: researcherHistoryKey, storePath: sharedStorePath },
      { sessionId: "researcher-current", updatedAt: now },
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        agentId: "main",
        storePath: sharedStorePath,
        pluginOwnerId: "memory-core",
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });

    expect(
      loadSessionEntry({ agentId: "main", sessionKey: mainKey, storePath: sharedStorePath }),
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "researcher",
        sessionKey: researcherKey,
        storePath: sharedStorePath,
      }),
    ).toMatchObject({ sessionId: "researcher-orphan" });
    await expect(
      loadTranscriptEvents({
        agentId: "researcher",
        sessionKey: researcherHistoryKey,
        sessionId: researcherHistoryId,
        storePath: sharedStorePath,
      }),
    ).resolves.toEqual([researcherHistoryEvent]);
  });

  it("does not reclaim orphaned historical windows owned by another plugin", async () => {
    const now = Date.now();
    const staleUpdatedAt = now - 600_000;
    const foreignKey = "agent:main:foreign-history";
    const foreignHistoryId = "foreign-history-previous";
    await replaceSessionEntry(
      { sessionKey: foreignKey, storePath },
      { sessionId: foreignHistoryId, updatedAt: staleUpdatedAt, pluginOwnerId: "other-plugin" },
    );
    const foreignEvent = {
      type: "metadata",
      timestamp: new Date(staleUpdatedAt).toISOString(),
      runId: "cleanup-race-marker-foreign",
    };
    await replaceTranscriptEvents(
      { sessionKey: foreignKey, sessionId: foreignHistoryId, storePath },
      [foreignEvent],
    );
    await replaceSessionEntry(
      { sessionKey: foreignKey, storePath },
      { sessionId: "foreign-history-current", updatedAt: now, pluginOwnerId: "other-plugin" },
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        pluginOwnerId: "memory-core",
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });

    await expect(
      loadTranscriptEvents({ sessionKey: foreignKey, sessionId: foreignHistoryId, storePath }),
    ).resolves.toEqual([foreignEvent]);
  });

  it("preserves foreign current windows when their session node is a placeholder", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cleanup-race-placeholder";
    const sessionId = "foreign-placeholder-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, updatedAt: now - 600_000, pluginOwnerId: "other-plugin" },
    );
    const event = {
      runId: "cleanup-race-marker-foreign-placeholder",
      timestamp: new Date(now - 600_000).toISOString(),
      type: "metadata",
    };
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = ? WHERE session_key = ?")
      .run("{}", -1, sessionKey);

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        pluginOwnerId: "memory-core",
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });

    expect(
      database.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ current_session_id: sessionId });
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([
      event,
    ]);
  });

  it("preserves owned nodes that still reference another plugin's historical generation", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cleanup-race-mixed-generations";
    const foreignSessionId = "mixed-foreign-history";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: foreignSessionId,
        updatedAt: now - 600_000,
        pluginOwnerId: "other-plugin",
      },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: foreignSessionId, storePath }, [
      {
        runId: "cleanup-race-marker-mixed-foreign",
        timestamp: new Date(now - 600_000).toISOString(),
        type: "metadata",
      },
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        previousSessionId: foreignSessionId,
        sessionId: "mixed-owned-current",
        updatedAt: now - 600_000,
        pluginOwnerId: "memory-core",
      },
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        storePath,
        pluginOwnerId: "memory-core",
        sessionKeySegmentPrefix: "cleanup-race-",
        transcriptContentMarker: "cleanup-race-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "mixed-owned-current",
      previousSessionId: foreignSessionId,
    });
  });

  it("revalidates entries before deleting their transcript state", async () => {
    const sessionKey = "agent:main:cleanup-race";
    const sessionId = "cleanup-race-session";
    const now = Date.now();
    const event = {
      type: "session",
      id: sessionId,
      content: "cleanup-race-marker transcript",
    } as const;
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: now });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected cleanup-race database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const cleanupNow = Date.now() + 60_000;
    const planned = planSessionLifecycleArtifactCleanup(database, {
      archiveRemovedEntryTranscripts: true,
      archiveDirectory: path.dirname(storePath),
      sessionKeySegmentPrefix: "cleanup-race",
      transcriptContentMarker: "cleanup-race-marker",
      orphanTranscriptMinAgeMs: 0,
      nowMs: cleanupNow,
    });
    expect(planned.entries).toHaveLength(1);
    expect(planned.deletePlans).toHaveLength(1);

    const refreshedEntry = { label: "refreshed", sessionId, updatedAt: now + 1 };
    let refreshed = false;
    archiveMaterializationHook.afterMaterialize = () => {
      refreshed = true;
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
        .run(JSON.stringify(refreshedEntry), refreshedEntry.updatedAt, sessionKey);
    };

    try {
      await expect(
        cleanupSessionLifecycleArtifactsCore({
          storePath,
          sessionKeySegmentPrefix: "cleanup-race",
          transcriptContentMarker: "cleanup-race-marker",
          orphanTranscriptMinAgeMs: 0,
          nowMs: cleanupNow,
        }),
      ).rejects.toThrow("SQLite lifecycle cleanup entry changed");
    } finally {
      archiveMaterializationHook.afterMaterialize = undefined;
    }

    expect(refreshed).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(refreshedEntry);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([
      event,
    ]);
  });

  it("releases the store writer while a transcript archive is materialized", async () => {
    const deletedKey = "agent:main:cleanup-race-deleted";
    const deletedSessionId = "cleanup-race-deleted-session";
    const writerKey = "agent:main:cleanup-race-writer";
    await replaceSessionEntry(
      { sessionKey: deletedKey, storePath },
      { sessionId: deletedSessionId, updatedAt: Date.now() },
    );
    await replaceTranscriptEvents(
      { sessionKey: deletedKey, sessionId: deletedSessionId, storePath },
      [
        {
          type: "session",
          id: deletedSessionId,
          content: "archive while another writer progresses",
        },
      ],
    );
    await replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      { sessionId: "cleanup-race-writer-session", updatedAt: Date.now() },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: deletedKey, storeKeys: [deletedKey] },
    });
    await materializationStarted;
    const writer = replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      { sessionId: "cleanup-race-writer-session", label: "progressed", updatedAt: Date.now() },
    );
    const progressedDuringMaterialization = await Promise.race([
      writer.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(writer).resolves.toMatchObject({ label: "progressed" });
    expect(progressedDuringMaterialization).toBe(true);
  });

  it("releases the store writer while a historical generation is archived", async () => {
    const deletedKey = "agent:main:historical-race-deleted";
    const currentSessionId = "historical-race-current";
    const historicalSessionId = "historical-race-unplanned";
    const writerKey = "agent:main:historical-race-writer";
    await replaceSessionEntry(
      { sessionKey: deletedKey, storePath },
      { sessionId: currentSessionId, updatedAt: Date.now() },
    );
    await replaceTranscriptEvents(
      { sessionKey: deletedKey, sessionId: currentSessionId, storePath },
      [{ type: "session", id: currentSessionId, content: "current transcript" }],
    );
    await replaceTranscriptEvents(
      { sessionKey: deletedKey, sessionId: historicalSessionId, storePath },
      [{ type: "session", id: historicalSessionId, content: "historical transcript" }],
    );
    await replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      { sessionId: "historical-race-writer-session", updatedAt: Date.now() },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: deletedKey, storeKeys: [deletedKey] },
    });
    await materializationStarted;
    const writer = replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      {
        sessionId: "historical-race-writer-session",
        label: "progressed",
        updatedAt: Date.now(),
      },
    );
    const progressedDuringMaterialization = await Promise.race([
      writer.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(writer).resolves.toMatchObject({ label: "progressed" });
    expect(progressedDuringMaterialization).toBe(true);
  });

  it("reports a transcript guard mismatch after publishing earlier history", async () => {
    const sessionKey = "agent:main:historical-guard-race";
    const sessionIds = ["historical-guard-first", "historical-guard-second", "guard-current"];
    const events = sessionIds.map((sessionId) => ({
      type: "session" as const,
      id: sessionId,
      content: `${sessionId} transcript`,
    }));
    for (const [index, sessionId] of sessionIds.entries()) {
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index + 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [events[index]!]);
    }
    const currentEntry = loadSessionEntry({ sessionKey, storePath });
    if (!currentEntry) {
      throw new Error("expected current guarded entry");
    }
    let materializations = 0;
    archiveMaterializationHook.afterMaterialize = () => {
      materializations += 1;
      if (materializations === 2) {
        replaceTranscriptEventsSync({ sessionKey, sessionId: sessionIds[2]!, storePath }, [
          { ...events[2]!, content: "concurrent transcript" },
        ]);
      }
    };

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      expectedEntry: currentEntry,
      expectedTranscript: {
        eventJson: [JSON.stringify(events[2])],
        sessionId: sessionIds[2]!,
      },
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(materializations).toBe(2);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(currentEntry);
    const archivedSessionId = result.archivedTranscripts[0]?.sessionId;
    expect(sessionIds.slice(0, 2)).toContain(archivedSessionId);
    for (const [index, historicalSessionId] of sessionIds.slice(0, 2).entries()) {
      await expect(
        loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
      ).resolves.toEqual(historicalSessionId === archivedSessionId ? [] : [events[index]!]);
    }
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: sessionIds[2]!, storePath }),
    ).resolves.toEqual([{ ...events[2]!, content: "concurrent transcript" }]);
  });

  it("reports an entry replacement during final transcript materialization", async () => {
    const sessionKey = "agent:main:entry-materialization-race";
    const sessionId = "entry-materialization-run";
    const events = [{ type: "session" as const, id: sessionId, content: "original transcript" }];
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
    const currentEntry = loadSessionEntry({ sessionKey, storePath });
    if (!currentEntry) {
      throw new Error("expected current guarded entry");
    }
    const replacementEntry = { ...currentEntry, label: "concurrent replacement" };
    archiveMaterializationHook.afterMaterialize = () => {
      replaceSessionEntrySync({ sessionKey, storePath }, replacementEntry);
    };

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      expectedEntry: currentEntry,
      expectedTranscript: { eventJson: [JSON.stringify(events[0])], sessionId },
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result).toEqual({
      archivedTranscripts: [],
      deleted: false,
      expectedEntryMismatch: true,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(replacementEntry);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(
      events,
    );
  });

  it("releases the store writer while lifecycle cleanup archives a transcript", async () => {
    const now = Date.now();
    const deletedKey = "agent:main:cleanup-race-archived";
    const deletedSessionId = "cleanup-race-archived-session";
    const writerKey = "agent:main:cleanup-race-cleanup-writer";
    await replaceSessionEntry(
      { sessionKey: deletedKey, storePath },
      { sessionId: deletedSessionId, updatedAt: now - 600_000 },
    );
    await replaceTranscriptEvents(
      { sessionKey: deletedKey, sessionId: deletedSessionId, storePath },
      [
        {
          runId: "cleanup-race-marker-archived",
          timestamp: new Date(now - 600_000).toISOString(),
          type: "metadata",
        },
      ],
    );
    await replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      { sessionId: "cleanup-race-cleanup-writer-session", updatedAt: now },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const cleanup = cleanupSessionLifecycleArtifactsCore({
      storePath,
      sessionKeySegmentPrefix: "cleanup-race-",
      transcriptContentMarker: "cleanup-race-marker",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs: now,
    });
    await materializationStarted;
    const writer = replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      {
        sessionId: "cleanup-race-cleanup-writer-session",
        label: "progressed",
        updatedAt: now + 1,
      },
    );
    const progressedDuringMaterialization = await Promise.race([
      writer.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseMaterialization();

    await expect(cleanup).resolves.toEqual({
      removedEntries: 1,
      archivedTranscriptArtifacts: 1,
    });
    await expect(writer).resolves.toMatchObject({ label: "progressed" });
    expect(progressedDuringMaterialization).toBe(true);
  });

  it("releases the store writer while a lifecycle mutation archives a transcript", async () => {
    const removedKey = "agent:main:lifecycle-race-archived";
    const removedEntry: SessionEntry = {
      sessionId: "lifecycle-race-archived-session",
      updatedAt: Date.now(),
    };
    const writerKey = "agent:main:lifecycle-race-writer";
    await replaceSessionEntry({ sessionKey: removedKey, storePath }, removedEntry);
    const persistedRemovedEntry = loadSessionEntry({ sessionKey: removedKey, storePath });
    if (!persistedRemovedEntry) {
      throw new Error("expected persisted lifecycle removal entry");
    }
    await replaceTranscriptEvents(
      { sessionKey: removedKey, sessionId: removedEntry.sessionId, storePath },
      [
        {
          type: "session",
          id: removedEntry.sessionId,
          content: "lifecycle mutation archive",
        },
      ],
    );
    await replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      { sessionId: "lifecycle-race-writer-session", updatedAt: Date.now() },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const mutation = applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey: removedKey,
          expectedEntry: persistedRemovedEntry,
          archiveRemovedTranscript: true,
        },
      ],
      skipMaintenance: true,
    });
    await materializationStarted;
    const writer = replaceSessionEntry(
      { sessionKey: writerKey, storePath },
      {
        sessionId: "lifecycle-race-writer-session",
        label: "progressed",
        updatedAt: Date.now(),
      },
    );
    const progressedDuringMaterialization = await Promise.race([
      writer.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseMaterialization();

    await expect(mutation).resolves.toMatchObject({
      removedEntries: 1,
      removedSessionKeys: [removedKey],
    });
    await expect(writer).resolves.toMatchObject({ label: "progressed" });
    expect(progressedDuringMaterialization).toBe(true);
  });

  it("reports zero maintenance removals when final compare-and-delete does not commit", async () => {
    const sessionKey = "agent:main:subagent:maintenance-compare-failed";
    const entry = { sessionId: "maintenance-compare-failed", updatedAt: 1 };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected maintenance race database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    let materializations = 0;
    archiveMaterializationHook.afterMaterialize = () => {
      materializations += 1;
      if (materializations !== 1) {
        return;
      }
      const changedEntry = { ...entry, label: "changed", updatedAt: 2 };
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
        .run(JSON.stringify(changedEntry), changedEntry.updatedAt, sessionKey);
    };

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
    });

    expect(result).toMatchObject({
      beforeCount: 1,
      afterCount: 1,
      removedEntries: 0,
      removedSessionKeys: [],
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
    });
    expect(materializations).toBe(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ label: "changed" });
  });

  it("retains committed maintenance counts when archive publication fails", async () => {
    const sessionKey = "agent:main:subagent:maintenance-publication-failed";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "maintenance-publication-failed", updatedAt: 1 },
    );
    archivePublicationHook.failNext = new Error("injected archive publication failure");

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
    });

    expect(result).toMatchObject({
      beforeCount: 1,
      afterCount: 0,
      modelRunPruned: 0,
      pruned: 1,
      capped: 0,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("splits byte-limited cleanup into real worker batches", async () => {
    const batches: string[][] = [];
    archiveMaterializationHook.onMaterialize = (ids) => void batches.push(ids);
    const ids = await runByteLimitedArchiveCleanupFixture(storePath);
    expect(batches.toSorted((left, right) => left[0]!.localeCompare(right[0]!))).toEqual(
      ids.toSorted((left, right) => left.localeCompare(right)).map((id) => [id]),
    );
  });
  it("continues a maintenance batch after one entry changes", async () => {
    const entryCount = 66;
    const historicalSessionId = "maintenance-batch-historical-session";
    const sessionKeyById = new Map<string, string>();
    const sessionKeys = Array.from(
      { length: entryCount },
      (_, index) => `agent:main:subagent:maintenance-batch-${String(index).padStart(2, "0")}`,
    );
    for (const [index, sessionKey] of sessionKeys.entries()) {
      const sessionId = `maintenance-batch-session-${String(index).padStart(2, "0")}`;
      sessionKeyById.set(sessionId, sessionKey);
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId, updatedAt: index === entryCount - 1 ? Date.now() : index + 1 },
      );
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        { type: "session", id: sessionId, content: `batch transcript ${index}` },
      ]);
    }
    const historicalOwnerKey = sessionKeys[entryCount - 2] ?? "";
    await replaceTranscriptEvents(
      { sessionKey: historicalOwnerKey, sessionId: historicalSessionId, storePath },
      [{ type: "session", id: historicalSessionId, content: "historical batch transcript" }],
    );

    const batchSizes: number[] = [];
    let currentBatchSessionIds: string[] = [];
    let materializations = 0;
    archiveMaterializationHook.onMaterialize = (sessionIds) => {
      currentBatchSessionIds = sessionIds;
      batchSizes.push(sessionIds.length);
    };
    let racedKey: string | undefined;
    archiveMaterializationHook.afterMaterialize = () => {
      materializations += 1;
      if (materializations !== 2) {
        return;
      }
      racedKey = sessionKeyById.get(currentBatchSessionIds[0] ?? "");
      if (!racedKey) {
        throw new Error("expected a maintenance entry in the second batch");
      }
      const current = loadSessionEntry({ sessionKey: racedKey, storePath });
      if (!current) {
        throw new Error("expected the raced maintenance entry to remain");
      }
      replaceSessionEntrySync(
        { sessionKey: racedKey, storePath },
        { ...current, label: "changed during batch materialization" },
      );
    };

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: {
        mode: "enforce",
        maxEntries: entryCount,
        pruneAfterMs: 60_000,
      },
    });

    expect(batchSizes).toEqual([64, 2]);
    expect(result).toMatchObject({
      beforeCount: entryCount,
      afterCount: 2,
      modelRunPruned: 0,
      pruned: 64,
      capped: 0,
    });
    expect(loadSessionEntry({ sessionKey: racedKey ?? "", storePath })).toMatchObject({
      label: "changed during batch materialization",
    });
    expect(loadSessionEntry({ sessionKey: sessionKeys.at(-1) ?? "", storePath })).toBeDefined();
    await expect(
      loadTranscriptEvents({
        sessionKey: historicalOwnerKey,
        sessionId: historicalSessionId,
        storePath,
      }),
    ).resolves.toHaveLength(0);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected maintenance batch database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    expect(
      database.db
        .prepare("SELECT 1 AS present FROM session_nodes WHERE session_key = ?")
        .get(historicalOwnerKey),
    ).toBeDefined();
  });

  it("retains unplanned historical windows behind a placeholder node", async () => {
    const sessionKey = "agent:main:unplanned-history";
    const currentEntry: SessionEntry = {
      sessionId: "current-planned-session",
      updatedAt: Date.now(),
      delivery: { kind: "none" },
    };
    const currentEvent = {
      type: "session",
      id: "current-planned-session",
      content: "planned current transcript",
    } as const;
    const historicalEvent = {
      type: "session",
      id: "unplanned-historical-session",
      content: "retained historical transcript",
    } as const;
    await replaceSessionEntry({ sessionKey, storePath }, currentEntry);
    await replaceTranscriptEvents({ sessionKey, sessionId: "current-planned-session", storePath }, [
      currentEvent,
    ]);
    await replaceTranscriptEvents(
      { sessionKey, sessionId: "unplanned-historical-session", storePath },
      [historicalEvent],
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey,
          expectedEntry: currentEntry,
          archiveRemovedTranscript: false,
        },
      ],
      maintenanceOverride: { mode: "enforce" },
    });

    expect(result.removedSessionKeys).toEqual([sessionKey]);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: "current-planned-session", storePath }),
    ).resolves.toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey,
        sessionId: "unplanned-historical-session",
        storePath,
      }),
    ).resolves.toEqual([historicalEvent]);

    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected retention database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    expect(
      database.db
        .prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ current_session_id: "unplanned-historical-session", entry_json: "{}" });
  });

  it("rehomes a window retained through a surviving previousSessionId reference", async () => {
    const retainedSessionId = "retained-previous-session";
    const survivorKey = "agent:main:window-survivor";
    const now = Date.now();
    const retainedEvent = {
      type: "session",
      id: retainedSessionId,
      content: "retained previous transcript",
    } as const;
    await replaceSessionEntry(
      { sessionKey: "agent:main:window-owner", storePath },
      { sessionId: retainedSessionId, updatedAt: now },
    );
    await replaceTranscriptEvents(
      { sessionKey: "agent:main:window-owner", sessionId: retainedSessionId, storePath },
      [retainedEvent],
    );
    await replaceSessionEntry(
      { sessionKey: survivorKey, storePath },
      {
        previousSessionId: retainedSessionId,
        sessionId: "current-survivor-session",
        updatedAt: now + 1,
      },
    );

    const deleted = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:window-owner",
        storeKeys: ["agent:main:window-owner"],
      },
    });

    expect(deleted.deleted).toBe(true);
    expect(deleted.archivedTranscripts).toEqual([]);
    await expect(
      loadTranscriptEvents({ sessionKey: survivorKey, sessionId: retainedSessionId, storePath }),
    ).resolves.toEqual([retainedEvent]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(retainedSessionId),
    ).toEqual({ session_key: survivorKey });
  });
});
