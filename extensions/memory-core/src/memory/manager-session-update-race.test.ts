import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemorySessionSyncTarget } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemorySourceSyncPlan } from "./manager-source-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session update sync", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it("indexes an update that arrives before an active sync clears dirty state", async () => {
    fixture.setStateDir(path.join(fixture.paths.workspace, ".state-session-update-during-sync"));
    const sessionId = "session-update-during-sync";
    const sessionKey = `agent:main:proof:${sessionId}`;
    const updatedMarker = "UPDATE DURING ACTIVE SYNC 811";
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    const owner = manager as unknown as {
      queuedSessionSync: Promise<void> | null;
      sessionPendingTargets: Map<string, MemorySessionSyncTarget>;
      sessionsDirty: boolean;
      sessionsReconcileDirty: boolean;
      syncArchiveFiles: (params: unknown) => Promise<MemorySourceSyncPlan>;
      processSessionUpdateBatch: () => Promise<void>;
    };
    let releaseActiveSync = () => {};
    const activeSyncGate = new Promise<void>((resolve) => {
      releaseActiveSync = resolve;
    });
    let markActiveSyncIndexed = () => {};
    const activeSyncIndexed = new Promise<void>((resolve) => {
      markActiveSyncIndexed = resolve;
    });
    let syncArchiveFilesSpy: { mockRestore: () => void } | undefined;
    try {
      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: Date.now(), content: "initial transcript" }],
      });
      await manager.sync({ reason: "test-baseline", force: true });

      owner.sessionsDirty = true;
      owner.sessionsReconcileDirty = true;
      const syncArchiveFiles = owner.syncArchiveFiles.bind(manager);
      syncArchiveFilesSpy = vi
        .spyOn(owner, "syncArchiveFiles")
        .mockImplementationOnce(async (params) => {
          const result = await syncArchiveFiles(params);
          markActiveSyncIndexed();
          await activeSyncGate;
          return result;
        });
      const activeSync = manager.sync({ reason: "test-active" });
      await activeSyncIndexed;

      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", timestamp: Date.now(), content: updatedMarker }],
      });
      owner.sessionPendingTargets.set(sessionKey, { agentId: "main", sessionId, sessionKey });
      await owner.processSessionUpdateBatch();
      const queuedSessionSync = owner.queuedSessionSync;
      expect(queuedSessionSync).not.toBeNull();

      releaseActiveSync();
      await activeSync;
      await queuedSessionSync;

      const observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
        readOnly: true,
      });
      try {
        const row = observer
          .prepare(
            "SELECT COUNT(*) AS count FROM memory_index_chunks WHERE source = 'sessions' AND text LIKE ?",
          )
          .get(`%${updatedMarker}%`) as { count: number };
        expect(row.count).toBeGreaterThan(0);
      } finally {
        observer.close();
      }
      expect(manager.status().dirty).toBe(false);
    } finally {
      syncArchiveFilesSpy?.mockRestore();
      releaseActiveSync();
      await manager.close?.();
      fixture.restoreStateDir();
    }
  });
});
