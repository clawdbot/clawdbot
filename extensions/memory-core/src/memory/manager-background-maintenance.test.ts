// Memory Core tests cover background reconciliation and full-retry maintenance.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import * as managerSourceState from "./manager-source-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory index background maintenance", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
  } = fixture;

  function pauseNextMemorySourceInspection() {
    const inspectionStarted = createDeferred<void>();
    const releaseInspection = createDeferred<void>();
    const inspectMemorySourceState = managerSourceState.inspectMemorySourceState;
    const inspectSpy = vi
      .spyOn(managerSourceState, "inspectMemorySourceState")
      .mockImplementationOnce(async (params) => {
        const inspection = await inspectMemorySourceState(params);
        inspectionStarted.resolve();
        await releaseInspection.promise;
        return inspection;
      });
    return { inspectionStarted, releaseInspection, inspectSpy };
  }

  it("recovers memory source drift without a watcher event or search-owned maintenance", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        sources: ["memory"],
        minScore: 0,
        hybrid: { enabled: true },
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      closeNativeMemoryWatchPairs: () => void;
      watchTimer: NodeJS.Timeout | null;
      lifecycleSafetySweepTimer: NodeJS.Timeout | null;
      lifecycleSafetySweep: Promise<void> | null;
      startLifecycleSafetySweep: () => void;
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };
    fields.closeNativeMemoryWatchPairs();
    if (fields.watchTimer) {
      clearTimeout(fields.watchTimer);
      fields.watchTimer = null;
    }
    if (fields.lifecycleSafetySweepTimer) {
      clearTimeout(fields.lifecycleSafetySweepTimer);
      fields.lifecycleSafetySweepTimer = null;
    }
    await fs.writeFile(
      path.join(fixture.paths.memory, "missed-watcher.md"),
      "Missed watcher lifecycle canary is ORBIT-729.",
    );
    const syncSpy = vi.spyOn(manager, "sync");
    const backgroundSync = vi.spyOn(fields, "syncPublishedIndexInBackground");

    fields.startLifecycleSafetySweep();
    const pendingSweep = fields.lifecycleSafetySweep;
    expect(pendingSweep).not.toBeNull();
    await pendingSweep;

    expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
    expect(backgroundSync).not.toHaveBeenCalled();
    await expect(
      manager.search("Missed watcher lifecycle canary ORBIT-729", {
        lexicalOnly: true,
        minScore: 0,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "memory/missed-watcher.md",
          snippet: expect.stringContaining("ORBIT-729"),
        }),
      ]),
    );
  });

  it("retries ordinary session dirtiness from a sessions-only manager lifecycle", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
        minScore: 0,
        hybrid: { enabled: true },
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      sessionsDirty: boolean;
      sessionsFullRetryDirty: boolean;
      sessionsReconcileDirty: boolean;
      sessionsDirtyFiles: Set<string>;
      lifecycleSafetySweepTimer: NodeJS.Timeout | null;
      lifecycleSafetySweep: Promise<void> | null;
      ensureLifecycleSafetySweep: (delayMs: number) => void;
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };
    if (fields.lifecycleSafetySweepTimer) {
      clearTimeout(fields.lifecycleSafetySweepTimer);
      fields.lifecycleSafetySweepTimer = null;
    }
    expect(manager.status().sources).toEqual(["sessions"]);
    fields.dirty = false;
    fields.memoryFullRetryDirty = false;
    fields.sessionsDirty = true;
    fields.sessionsFullRetryDirty = false;
    fields.sessionsReconcileDirty = false;
    fields.sessionsDirtyFiles.clear();
    const syncStarted = createDeferred<void>();
    const releaseSync = createDeferred<void>();
    const syncSpy = vi.spyOn(manager, "sync").mockImplementation(async () => {
      syncStarted.resolve();
      await releaseSync.promise;
    });
    const fullRetrySync = vi.spyOn(fields, "syncPublishedIndexInBackground");

    let pendingSweep: Promise<void> | null = null;
    try {
      fields.ensureLifecycleSafetySweep(0);
      await syncStarted.promise;
      pendingSweep = fields.lifecycleSafetySweep;
      expect(pendingSweep).not.toBeNull();
      expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
      expect(fullRetrySync).not.toHaveBeenCalled();
    } finally {
      releaseSync.resolve();
      await pendingSweep;
    }
  });

  it("defers reconciliation when a watcher timer arrives during source inspection", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        sources: ["memory"],
        minScore: 0,
        hybrid: { enabled: true },
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      dirty: boolean;
      watchTimer: NodeJS.Timeout | null;
      lifecycleSafetySweepTimer: NodeJS.Timeout | null;
      lifecycleSafetySweep: Promise<void> | null;
      startLifecycleSafetySweep: () => void;
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };
    if (fields.lifecycleSafetySweepTimer) {
      clearTimeout(fields.lifecycleSafetySweepTimer);
      fields.lifecycleSafetySweepTimer = null;
    }
    vi.useFakeTimers();
    const syncSpy = vi.spyOn(manager, "sync").mockResolvedValue(undefined);
    const fullRetrySync = vi.spyOn(fields, "syncPublishedIndexInBackground");
    const { inspectionStarted, releaseInspection, inspectSpy } = pauseNextMemorySourceInspection();
    let pendingSweep: Promise<void> | null = null;

    try {
      fields.startLifecycleSafetySweep();
      pendingSweep = fields.lifecycleSafetySweep;
      expect(pendingSweep).not.toBeNull();
      await inspectionStarted.promise;

      fields.dirty = true;
      fields.watchTimer = setTimeout(() => {
        fields.watchTimer = null;
      }, 60_000);
      releaseInspection.resolve();
      await pendingSweep;

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).not.toHaveBeenCalled();
      expect(fullRetrySync).not.toHaveBeenCalled();
      expect(fields.lifecycleSafetySweepTimer).not.toBeNull();

      if (fields.watchTimer) {
        clearTimeout(fields.watchTimer);
        fields.watchTimer = null;
      }
      await vi.advanceTimersByTimeAsync(29_999);
      expect(syncSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await fields.lifecycleSafetySweep;
      expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
      expect(fullRetrySync).not.toHaveBeenCalled();
    } finally {
      releaseInspection.resolve();
      await pendingSweep;
      if (fields.watchTimer) {
        clearTimeout(fields.watchTimer);
        fields.watchTimer = null;
      }
      if (fields.lifecycleSafetySweepTimer) {
        clearTimeout(fields.lifecycleSafetySweepTimer);
        fields.lifecycleSafetySweepTimer = null;
      }
      inspectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("routes a full retry that arrives during source inspection through published maintenance", async () => {
    providerFixture.forceNoProvider = true;
    const manager = await getPersistentManager(
      createCfg({
        provider: "none",
        sources: ["memory"],
        minScore: 0,
        hybrid: { enabled: true },
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      dirty: boolean;
      memoryFullRetryDirty: boolean;
      lifecycleSafetySweepTimer: NodeJS.Timeout | null;
      lifecycleSafetySweep: Promise<void> | null;
      startLifecycleSafetySweep: () => void;
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };
    if (fields.lifecycleSafetySweepTimer) {
      clearTimeout(fields.lifecycleSafetySweepTimer);
      fields.lifecycleSafetySweepTimer = null;
    }
    const syncSpy = vi.spyOn(manager, "sync").mockResolvedValue(undefined);
    const fullRetrySync = vi
      .spyOn(fields, "syncPublishedIndexInBackground")
      .mockResolvedValue(undefined);
    const { inspectionStarted, releaseInspection, inspectSpy } = pauseNextMemorySourceInspection();
    let pendingSweep: Promise<void> | null = null;

    try {
      fields.startLifecycleSafetySweep();
      pendingSweep = fields.lifecycleSafetySweep;
      expect(pendingSweep).not.toBeNull();
      await inspectionStarted.promise;

      fields.dirty = true;
      fields.memoryFullRetryDirty = true;
      releaseInspection.resolve();
      await pendingSweep;

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(fullRetrySync).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
      expect(syncSpy).not.toHaveBeenCalled();
    } finally {
      releaseInspection.resolve();
      await pendingSweep;
      inspectSpy.mockRestore();
    }
  });

  it.each([
    { name: "full memory retry", source: "memory", fullRetry: true },
    { name: "full session retry", source: "sessions", fullRetry: true },
  ] as const)(
    "keeps search usable while maintenance syncs $name",
    async ({ source, fullRetry }) => {
      providerFixture.forceNoProvider = true;
      const cfg = createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        minScore: 0,
        onSearch: true,
        hybrid: { enabled: true },
      });
      const manager = await getPersistentManager(cfg);
      await manager.sync({ reason: "test", force: true });
      // This fixture supplies one exact dirty generation, without later native
      // watcher notifications adding another generation during the handoff.
      (
        manager as unknown as { closeNativeMemoryWatchPairs: () => void }
      ).closeNativeMemoryWatchPairs();
      const content = "Current memory appears only after the dirty search sync.";
      if (source === "memory") {
        await fs.writeFile(path.join(fixture.paths.memory, "search-sync.md"), content);
      } else {
        await seedMemoryIndexSessionTranscript({
          sessionId: "search-sync",
          messages: [{ role: "assistant", timestamp: Date.now(), content }],
        });
      }
      const servingFields = manager as unknown as {
        dirty: boolean;
        memoryFullRetryDirty: boolean;
        sessionsDirty: boolean;
        sessionsFullRetryDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        listSessionCorpusEntries: () => Promise<Array<{ sessionFile: string }>>;
        awaitManagerIdle: () => Promise<void>;
      };
      // A full session retry deliberately coexists with ordinary memory dirtiness.
      // Its search-time handoff must not pull the memory source into maintenance.
      servingFields.dirty = true;
      servingFields.memoryFullRetryDirty = source === "memory" && fullRetry;
      servingFields.sessionsDirty = source === "sessions";
      servingFields.sessionsFullRetryDirty = source === "sessions" && fullRetry;
      if (source === "sessions") {
        const entries = await servingFields.listSessionCorpusEntries();
        expect(entries).toHaveLength(1);
        servingFields.sessionsDirtyFiles = new Set(entries.map((entry) => entry.sessionFile));
      }

      const maintenanceReady = createDeferred<void>();
      const releaseMaintenance = createDeferred<void>();
      const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
      let maintenanceClosed = false;
      let maintenanceFields:
        | {
            runInPlaceReindex: (params: unknown) => Promise<void>;
            syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
            syncArchiveFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
          }
        | undefined;
      const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
        const acquired = await originalGet(params);
        if (params.purpose !== "maintenance" || !acquired) {
          return acquired;
        }
        const closeMaintenance = acquired.close.bind(acquired);
        vi.spyOn(acquired, "close").mockImplementation(async () => {
          await closeMaintenance();
          maintenanceClosed = true;
        });
        const fields = acquired as unknown as NonNullable<typeof maintenanceFields>;
        maintenanceFields = fields;
        vi.spyOn(fields, "runInPlaceReindex");
        const sourceSync = source === "memory" ? "syncMemoryFiles" : "syncArchiveFiles";
        const syncSource = fields[sourceSync].bind(acquired);
        if (source === "sessions") {
          vi.spyOn(fields, "syncMemoryFiles");
        }
        vi.spyOn(fields, sourceSync).mockImplementation(async (syncParams) => {
          // Memory full retries publish a completed shadow generation atomically, so
          // hold after its write. Session retries write to the live generation, so
          // hold before the write to prove reads stay on the published state.
          if (source === "sessions") {
            maintenanceReady.resolve();
            await releaseMaintenance.promise;
            return await syncSource(syncParams);
          }
          const result = await syncSource(syncParams);
          maintenanceReady.resolve();
          await releaseMaintenance.promise;
          return result;
        });
        return acquired;
      });

      try {
        const firstSearch = manager.search("zebra", { maxResults: 5, minScore: 0 });
        await maintenanceReady.promise;
        expect(manager.status()).toMatchObject({ dirty: true });
        expect(maintenanceFields!.runInPlaceReindex).toHaveBeenCalledTimes(
          source === "memory" ? 1 : 0,
        );
        const sourceSync =
          maintenanceFields![source === "memory" ? "syncMemoryFiles" : "syncArchiveFiles"];
        expect(sourceSync).toHaveBeenCalledTimes(1);
        expect(sourceSync).toHaveBeenCalledWith(
          expect.objectContaining({ needsFullReindex: fullRetry }),
        );
        if (source === "sessions") {
          expect(maintenanceFields!.syncMemoryFiles).not.toHaveBeenCalled();
        }

        const publishedResults = await firstSearch;
        expect(publishedResults.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
        await expect(
          manager.search("current dirty search sync", { maxResults: 5, minScore: 0 }),
        ).resolves.toEqual([]);

        releaseMaintenance.resolve();
        await servingFields.awaitManagerIdle();
        expect(manager.status().dirty).toBe(source === "sessions");

        const refreshedResults = await manager.search("current dirty search sync", {
          maxResults: 5,
          minScore: 0,
        });
        expect(refreshedResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ source, snippet: expect.stringContaining(content) }),
          ]),
        );
        expect(maintenanceClosed).toBe(true);
      } finally {
        releaseMaintenance.resolve();
        await servingFields.awaitManagerIdle();
        getSpy.mockRestore();
      }
    },
  );
});
