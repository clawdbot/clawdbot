import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.js";
import {
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  loadSessionStore,
  patchSessionEntry,
  readSessionUpdatedAt,
  resolveSessionFilePath,
  resolveSessionStoreEntry,
  resolveSessionStoreBackupPaths,
  resolveStorePath,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES = 16 * 1024 * 1024;

describe("session-store-runtime compatibility surface", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-store-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry,
    });
  }

  it("keeps the public session read shape while using accessor-backed exports", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    expect(readSessionUpdatedAt({ sessionKey, storePath })).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: 10,
        }),
      },
    ]);
    const compatibilityStore = loadSessionStore(storePath, { skipCache: true });
    expect(compatibilityStore).toEqual({
      [sessionKey]: expect.objectContaining({
        model: "gpt-5.5",
        sessionFile: `sqlite:main:session-1:${path.join(tempDir, "openclaw-agent.sqlite")}`,
        sessionId: "session-1",
        updatedAt: 10,
      }),
    });
    compatibilityStore[sessionKey]!.model = "mutated";
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBe("gpt-5.5");
    expect(getSessionEntry({ sessionKey, storePath })?.sessionFile).toBeUndefined();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 20,
      },
    });
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("keeps the beta.5 official plugin import set linkable", () => {
    expect({
      loadSessionStore,
      resolveSessionFilePath,
      resolveSessionStoreEntry,
      resolveStorePath,
      updateSessionStore,
    }).toEqual({
      loadSessionStore: expect.any(Function),
      resolveSessionFilePath: expect.any(Function),
      resolveSessionStoreEntry: expect.any(Function),
      resolveStorePath: expect.any(Function),
      updateSessionStore: expect.any(Function),
    });
  });

  it("materializes SQLite transcripts for beta.5 file-based doctor inspection", async () => {
    const sessionId = "session-feishu";
    const sessionKey = "agent:main:feishu:direct:user";
    await seedSessionEntry(sessionKey, {
      sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        id: sessionId,
        timestamp: new Date(10).toISOString(),
        type: "session",
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        message: { content: "hello", role: "user" },
        cwd: tempDir,
      },
    );

    const compatibilityEntry = loadSessionStore(storePath)[sessionKey];
    const transcriptPath = resolveSessionFilePath(sessionId, compatibilityEntry, {
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    expect(transcriptPath).toBe(path.join(tempDir, `${sessionId}.jsonl`));
    expect(fs.statSync(transcriptPath).mode & 0o777).toBe(0o600);
    expect(
      fs
        .readFileSync(transcriptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "hello", role: "user" }),
        type: "message",
      }),
    ]);
    const codexSidecarPath = `${transcriptPath}.codex-app-server.json`;
    fs.writeFileSync(codexSidecarPath, "{}\n", { mode: 0o600 });
    expect(codexSidecarPath).toBe(path.join(tempDir, `${sessionId}.jsonl.codex-app-server.json`));
  });

  it("preserves beta.5 doctor archives after deleting the compatibility row", async () => {
    const sessionId = "session-feishu-archive";
    const sessionKey = "agent:main:feishu:direct:archive";
    await seedSessionEntry(sessionKey, {
      sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        id: sessionId,
        timestamp: new Date(10).toISOString(),
        type: "session",
      },
    );

    const compatibilityEntry = loadSessionStore(storePath)[sessionKey];
    const transcriptPath = resolveSessionFilePath(sessionId, compatibilityEntry, {
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    const archivePath = `${transcriptPath}.deleted.2026-07-12T12-34-56.000Z`;
    await updateSessionStore(
      storePath,
      (store) => {
        delete store[sessionKey];
      },
      { skipMaintenance: true },
    );
    const repairedPath = resolveSessionFilePath(sessionId, compatibilityEntry, {
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    expect(repairedPath).toBe(transcriptPath);
    expect(fs.readFileSync(repairedPath, "utf8")).toContain(`"id":"${sessionId}"`);
    fs.renameSync(repairedPath, archivePath);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("uses a sparse stat sentinel for beta.5 Feishu oversized transcript inspection", async () => {
    const sessionId = "session-feishu-large";
    const sessionKey = "agent:main:feishu:direct:large";
    await seedSessionEntry(sessionKey, { sessionId, updatedAt: 10 });
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        id: sessionId,
        timestamp: new Date(10).toISOString(),
        type: "session",
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        message: {
          content: "x".repeat(LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES),
          role: "user",
        },
        cwd: tempDir,
      },
    );

    const compatibilityEntry = loadSessionStore(storePath)[sessionKey];
    const transcriptPath = resolveSessionFilePath(sessionId, compatibilityEntry, {
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    const stat = fs.statSync(transcriptPath);
    expect(stat.size).toBe(LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES + 1);
    if (process.platform !== "win32") {
      expect(stat.blocks * 512).toBeLessThan(stat.size);
    }
  });

  it("matches beta.5 Feishu's selected owner for a deduped shared path", async () => {
    const sharedStorePath = path.join(tempDir, "shared.json");
    await upsertSessionEntry({
      agentId: "main",
      entry: { sessionId: "session-main", updatedAt: 10 },
      sessionKey: "agent:main:main",
      storePath: sharedStorePath,
    });
    await upsertSessionEntry({
      agentId: "work",
      entry: { sessionId: "session-work", updatedAt: 20 },
      sessionKey: "agent:work:main",
      storePath: sharedStorePath,
    });

    // Feishu doctor stores targets in a path-keyed map, so the last configured
    // agent is also the owner selected by its subsequent load/update calls.
    resolveStorePath(sharedStorePath, { agentId: "main" });
    resolveStorePath(sharedStorePath, { agentId: "work" });
    expect(loadSessionStore(sharedStorePath)).toEqual({
      "agent:work:main": expect.objectContaining({ sessionId: "session-work" }),
    });

    await updateSessionStore(
      sharedStorePath,
      (store) => {
        store["agent:work:main"] = {
          ...store["agent:work:main"]!,
          model: "gpt-5.5",
        };
      },
      { skipMaintenance: true },
    );
    expect(
      getSessionEntry({
        agentId: "work",
        sessionKey: "agent:work:main",
        storePath: sharedStorePath,
      })?.model,
    ).toBe("gpt-5.5");
    expect(
      getSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: sharedStorePath,
      })?.model,
    ).toBeUndefined();
  });

  it("applies whole-store compatibility mutations through SQLite rows", async () => {
    await seedSessionEntry("agent:main:remove", {
      sessionId: "session-remove",
      updatedAt: 10,
    });
    await seedSessionEntry("agent:main:update", {
      model: "gpt-5.5",
      sessionId: "session-update",
      updatedAt: 10,
    });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store["agent:main:remove"];
          store["agent:main:update"] = {
            ...store["agent:main:update"]!,
            model: "gpt-5.6",
          };
          return "updated";
        },
        { skipMaintenance: true },
      ),
    ).resolves.toBe("updated");

    expect(getSessionEntry({ sessionKey: "agent:main:remove", storePath })).toBeUndefined();
    expect(getSessionEntry({ sessionKey: "agent:main:update", storePath })?.model).toBe("gpt-5.6");
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("serializes compatibility callbacks with concurrent row writes", async () => {
    const sessionKey = "agent:main:serialized";
    await seedSessionEntry(sessionKey, {
      model: "initial",
      sessionId: "session-serialized",
      updatedAt: 10,
    });
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const compatibilityMutation = updateSessionStore(
      storePath,
      async (store) => {
        markMutationStarted();
        await mutationGate;
        store[sessionKey] = { ...store[sessionKey]!, model: "compatibility" };
      },
      { skipMaintenance: true },
    );

    await mutationStarted;
    const concurrentWrite = seedSessionEntry(sessionKey, {
      model: "concurrent",
      sessionId: "session-serialized",
      updatedAt: 20,
    });
    releaseMutation();

    await expect(compatibilityMutation).resolves.toBeUndefined();
    await expect(concurrentWrite).resolves.toBeUndefined();
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBe("concurrent");
  });

  it("rejects compatibility removal of durable harness sessions", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:compatibility";
    await seedSessionEntry(sessionKey, {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "session-harness",
      updatedAt: 10,
    });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store[sessionKey];
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "session-harness",
    });
  });

  it("rejects compatibility removal of legacy non-reserved locked sessions", async () => {
    const sessionKey = "agent:main:legacy-locked";
    await seedSessionEntry(sessionKey, {
      modelSelectionLocked: true,
      sessionId: "session-legacy-locked",
      updatedAt: 10,
    });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store[sessionKey];
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      modelSelectionLocked: true,
      sessionId: "session-legacy-locked",
    });
  });

  it("discards skipped compatibility projections before validating mutations", async () => {
    const sessionKey = "agent:main:skip-locked";
    await seedSessionEntry(sessionKey, {
      modelSelectionLocked: true,
      sessionId: "session-skip-locked",
      updatedAt: 10,
    });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store[sessionKey];
          return "skip";
        },
        {
          skipMaintenance: true,
          skipSaveWhenResult: (result) => result === "skip",
        },
      ),
    ).resolves.toBe("skip");
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      modelSelectionLocked: true,
      sessionId: "session-skip-locked",
    });
  });

  it("keeps the public entry mutation signature while delegating to the seam", async () => {
    const sessionKey = "agent:main:main";

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toBeNull();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    const beforePatch = getSessionEntry({ sessionKey, storePath });
    await expect(
      patchSessionEntry({
        sessionKey,
        storePath,
        preserveActivity: true,
        update: (_entry, context) => ({
          providerOverride: context.existingEntry ? "openai" : "missing",
          updatedAt: 20,
        }),
      }),
    ).resolves.toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
    });
  });

  it("preserves resolved maintenance settings through entry patches", async () => {
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await seedSessionEntry(staleSessionKey, {
      sessionId: "session-stale",
      updatedAt: now - 8 * DAY_MS,
    });
    await seedSessionEntry(activeSessionKey, {
      sessionId: "session-active",
      updatedAt: now,
    });

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 7 * DAY_MS,
          modelRunPruneAfterMs: DAY_MS,
          maxEntries: 1,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: activeSessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });
    expect(getSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
  });

  it("forwards maintenance suppression through entry patches", async () => {
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await seedSessionEntry(staleSessionKey, {
      sessionId: "session-stale",
      updatedAt: now - 8 * DAY_MS,
    });
    await seedSessionEntry(activeSessionKey, {
      sessionId: "session-active",
      updatedAt: now,
    });

    await patchSessionEntry({
      sessionKey: activeSessionKey,
      storePath,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        modelRunPruneAfterMs: DAY_MS,
        maxEntries: 1,
        resetArchiveRetentionMs: 7 * DAY_MS,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      requireWriteSuccess: true,
      skipMaintenance: true,
      update: () => ({ model: "gpt-5.5" }),
    });

    expect(getSessionEntry({ sessionKey: staleSessionKey, storePath })).toMatchObject({
      sessionId: "session-stale",
    });
  });

  it("accepts pre-model-run maintenance configs through entry patches", async () => {
    const staleModelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await seedSessionEntry(staleModelRunKey, {
      sessionId: "session-probe",
      updatedAt: now - 2 * DAY_MS,
    });
    await seedSessionEntry(activeSessionKey, {
      sessionId: "session-active",
      updatedAt: now,
    });

    const legacyMaintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 500,
      resetArchiveRetentionMs: 7 * DAY_MS,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: legacyMaintenanceConfig,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: staleModelRunKey, storePath })).toMatchObject({
      sessionId: "session-probe",
    });
  });

  it("deletes entries by session identity", async () => {
    const sessionKey = "agent:main:delete-me";
    await seedSessionEntry(sessionKey, {
      sessionId: "session-delete-me",
      updatedAt: Date.now(),
    });

    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(true);
    await expect(deleteSessionEntry({ sessionKey, storePath })).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("resolves agent-scoped custom SQLite stores for backups", () => {
    const customStorePath = path.join(tempDir, "custom", "sessions.json");

    expect(
      resolveSessionStoreBackupPaths({
        agentId: "support",
        storePath: customStorePath,
      }),
    ).toContain(path.join(tempDir, "custom", "openclaw-agent.support.sqlite"));
  });

  it("cleans lifecycle artifacts through the accessor-backed SDK wrapper", async () => {
    const sessionKey = "agent:main:lifecycle-owned-old";
    const oldTimestamp = Date.now() - 600_000;
    await seedSessionEntry(sessionKey, {
      sessionId: "lifecycle-owned-old",
      updatedAt: oldTimestamp,
    });
    await seedSessionEntry("agent:main:regular", {
      sessionId: "regular",
      updatedAt: Date.now(),
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionKey, sessionId: "lifecycle-owned-old", storePath },
      {
        runId: "lifecycle-owned-old",
        timestamp: new Date(oldTimestamp).toISOString(),
        type: "metadata",
      },
    );

    await expect(
      cleanupSessionLifecycleArtifacts({
        agentId: "main",
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 1,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(getSessionEntry({ sessionKey: "agent:main:regular", storePath })).toMatchObject({
      sessionId: "regular",
    });
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-old.jsonl.deleted.")),
    ).toHaveLength(1);
  });

  it("honors lifecycle cleanup without archiving removed entry transcripts", async () => {
    const sessionKey = "agent:main:lifecycle-owned-discard";
    const oldTimestamp = Date.now() - 600_000;
    await seedSessionEntry(sessionKey, {
      sessionId: "lifecycle-owned-discard",
      updatedAt: oldTimestamp,
    });
    await appendTranscriptEvent(
      { agentId: "main", sessionKey, sessionId: "lifecycle-owned-discard", storePath },
      {
        runId: "lifecycle-owned-discard",
        timestamp: new Date(oldTimestamp).toISOString(),
        type: "metadata",
      },
    );

    await expect(
      cleanupSessionLifecycleArtifacts({
        agentId: "main",
        archiveRemovedEntryTranscripts: false,
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 0,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-discard.jsonl.deleted.")),
    ).toHaveLength(0);
  });
});
