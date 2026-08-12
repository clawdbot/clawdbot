import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  patchSessionEntryCore as patchInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-store-runtime recovery boundary", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-sdk-session-recovery-");
    storePath = path.join(tempDir, "sessions.json");
  });

  function expectRecoveryCleared(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): void {
    const entry = loadInternalSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    expect(entry).toMatchObject({ sessionId: params.sessionId });
    expect(entry?.abortedLastRun).not.toBe(true);
    expect(entry?.restartRecoveryRuns).toBeUndefined();
    expect(entry).not.toHaveProperty("mainRestartRecovery");
    expect(entry).not.toHaveProperty("activeWriterRunId");
    expect(entry).not.toHaveProperty("lifecycleRunId");
    expect(entry).not.toHaveProperty("restartRecoveryOwner");
  }

  it("allows public recovery fields to change without an active core transaction", async () => {
    const sessionKey = "agent:main:healthy-public-recovery";
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "healthy-session",
        updatedAt: 10,
      },
    });

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      }),
    });

    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "healthy-session",
    });
  });

  it("rejects core recovery state and ownership from runtime-escaped creation inputs", async () => {
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-injected",
      revision: 1,
    };
    const patchSessionKey = "agent:main:patch-created";
    await patchSessionEntry({
      fallbackEntry: {
        mainRestartRecovery,
        restartRecoveryOwner: "external",
        sessionId: "patch-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: patchSessionKey,
      storePath,
      update: () => ({ updatedAt: 20 }),
    });
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "mainRestartRecovery",
    );
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "restartRecoveryOwner",
    );

    const upsertSessionKey = "agent:main:upsert-created";
    await upsertSessionEntry({
      entry: {
        mainRestartRecovery,
        restartRecoveryOwner: "external",
        sessionId: "upsert-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: upsertSessionKey,
      storePath,
    });
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("restartRecoveryOwner");
  });

  it("hides core recovery state and preserves it across public mutations", async () => {
    const sessionKey = "agent:main:recovery-owned";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-1",
      reservation: {
        attempt: 1,
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      activeWriterRunId: "run-writer",
      abortedLastRun: true,
      lifecycleRunId: "run-lifecycle",
      mainRestartRecovery,
      model: "gpt-5.5",
      restartRecoveryOwner: "external",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "session-recovery",
      updatedAt: 10,
    } as InternalSessionEntry);

    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("mainRestartRecovery");
    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("activeWriterRunId");
    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("lifecycleRunId");
    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("restartRecoveryOwner");
    expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty("mainRestartRecovery");

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: (entry) => {
        entry.restartRecoveryRuns?.splice(0);
        return {
          activeWriterRunId: "injected-writer",
          abortedLastRun: false,
          lifecycleRunId: "injected-lifecycle",
          mainRestartRecovery: undefined,
          model: "gpt-5.6",
          restartRecoveryOwner: "openclaw",
          restartRecoveryRuns: undefined,
        } as unknown as Partial<SessionEntry>;
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      activeWriterRunId: "run-writer",
      abortedLastRun: true,
      lifecycleRunId: "run-lifecycle",
      mainRestartRecovery,
      model: "gpt-5.6",
      restartRecoveryOwner: "external",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await updateSessionStoreEntry({
      sessionKey,
      storePath,
      update: () => ({ abortedLastRun: false, restartRecoveryRuns: undefined }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      activeWriterRunId: "run-writer",
      abortedLastRun: true,
      lifecycleRunId: "run-lifecycle",
      mainRestartRecovery,
      restartRecoveryOwner: "external",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-recovery",
        updatedAt: 20,
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      activeWriterRunId: "run-writer",
      abortedLastRun: true,
      lifecycleRunId: "run-lifecycle",
      mainRestartRecovery,
      restartRecoveryOwner: "external",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "session-recovery",
      updatedAt: 20,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("clears core recovery state when public replacements change session identity", async () => {
    const patchKey = "agent:main:telegram:direct:patch-rotation";
    const upsertKey = "agent:main:telegram:direct:upsert-rotation";
    const upsertStorePath = path.join(tempDir, "upsert-sessions.json");
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "rotation-cycle",
      revision: 1,
    };
    await upsertSessionEntry({
      agentId: "main",
      entry: {
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "patch-generation", runId: "patch-run" }],
        sessionId: "patch-before",
        updatedAt: 10,
      },
      sessionKey: patchKey,
      storePath,
    });
    await patchInternalSessionEntry(
      { agentId: "main", sessionKey: patchKey, storePath },
      () =>
        ({
          abortedLastRun: true,
          mainRestartRecovery,
          restartRecoveryRuns: [{ lifecycleGeneration: "patch-generation", runId: "patch-run" }],
        }) as Partial<InternalSessionEntry>,
    );
    await upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "upsert-before", updatedAt: 10 },
      sessionKey: upsertKey,
      storePath: upsertStorePath,
    });
    await patchInternalSessionEntry(
      { agentId: "main", sessionKey: upsertKey, storePath: upsertStorePath },
      () =>
        ({
          abortedLastRun: true,
          mainRestartRecovery,
          restartRecoveryRuns: [{ lifecycleGeneration: "upsert-generation", runId: "upsert-run" }],
        }) as Partial<InternalSessionEntry>,
    );

    await patchSessionEntry({
      replaceEntry: true,
      sessionKey: patchKey,
      storePath,
      update: () => ({ sessionId: "patch-after", updatedAt: 20 }),
    });
    await upsertSessionEntry({
      entry: {
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "upsert-generation", runId: "upsert-run" }],
        sessionId: "upsert-after",
        updatedAt: 20,
      },
      sessionKey: upsertKey,
      storePath: upsertStorePath,
    });

    expectRecoveryCleared({ sessionId: "patch-after", sessionKey: patchKey, storePath });
    expectRecoveryCleared({
      sessionId: "upsert-after",
      sessionKey: upsertKey,
      storePath: upsertStorePath,
    });
  });

  it("clears core recovery state when public patches change session identity", async () => {
    const patchKey = "agent:main:telegram:direct:patch-rotation";
    const updateKey = "agent:main:telegram:direct:update-rotation";
    const updateStorePath = path.join(tempDir, "update-patch-sessions.json");
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "rotation-cycle",
      revision: 1,
    };
    await upsertSessionEntry({
      agentId: "main",
      entry: {
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "patch-generation", runId: "patch-run" }],
        sessionId: "patch-before",
        updatedAt: 10,
      },
      sessionKey: patchKey,
      storePath,
    });
    await upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "update-before", updatedAt: 10 },
      sessionKey: updateKey,
      storePath: updateStorePath,
    });
    await patchInternalSessionEntry(
      { agentId: "main", sessionKey: patchKey, storePath },
      () =>
        ({
          abortedLastRun: true,
          mainRestartRecovery,
          restartRecoveryRuns: [{ lifecycleGeneration: "patch-generation", runId: "patch-run" }],
        }) as Partial<InternalSessionEntry>,
    );
    await patchInternalSessionEntry(
      { agentId: "main", sessionKey: updateKey, storePath: updateStorePath },
      () =>
        ({
          abortedLastRun: true,
          mainRestartRecovery,
          restartRecoveryRuns: [{ lifecycleGeneration: "update-generation", runId: "update-run" }],
        }) as Partial<InternalSessionEntry>,
    );

    await patchSessionEntry({
      sessionKey: patchKey,
      skipMaintenance: true,
      storePath,
      update: () => ({ sessionId: "patch-after", updatedAt: 20 }),
    });
    await updateSessionStoreEntry({
      sessionKey: updateKey,
      skipMaintenance: true,
      storePath: updateStorePath,
      update: () => ({ sessionId: "update-after", updatedAt: 20 }),
    });

    expectRecoveryCleared({ sessionId: "patch-after", sessionKey: patchKey, storePath });
    expectRecoveryCleared({
      sessionId: "update-after",
      sessionKey: updateKey,
      storePath: updateStorePath,
    });
  });
});
