import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  resolveSessionStoreBackupPaths,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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
