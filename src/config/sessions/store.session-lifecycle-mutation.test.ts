// SQLite session lifecycle operations own entry mutation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  loadSessionEntry,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

type TestTranscriptEvent = Parameters<typeof replaceSqliteTranscriptEvents>[1][number];

describe("session store lifecycle mutations", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-lifecycle-mutation-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resets an entry in SQLite while archiving the previous transcript rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:room", storePath },
      {
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-1",
            createdAt: now,
            postCompaction: { sessionId: "post-compaction-session" },
            preCompaction: { sessionId: "pre-compaction-session" },
            reason: "manual",
            sessionId: "checkpoint-session",
            sessionKey: "agent:main:room",
          },
        ],
        sessionId: "old-session",
        updatedAt: now,
        usageFamilySessionIds: ["old-session", "usage-family-session"],
      },
    );
    for (const sessionId of [
      "old-session",
      "usage-family-session",
      "checkpoint-session",
      "pre-compaction-session",
      "post-compaction-session",
    ]) {
      await replaceSqliteTranscriptEvents({ sessionKey: "agent:main:room", sessionId, storePath }, [
        createTranscriptEvent(sessionId, `before reset ${sessionId}`),
      ]);
    }
    const transcriptUpdates = recordTranscriptUpdateFiles();
    let callbackTranscriptEvents: TestTranscriptEvent[] = [];

    const result = await resetSessionEntryLifecycle({
      storePath,
      target: {
        canonicalKey: "agent:main:room",
        storeKeys: ["agent:main:room", "Agent:Main:Room"],
      },
      buildNextEntry: (): SessionEntry => ({
        sessionId: "next-session",
        updatedAt: now + 1,
        systemSent: false,
        abortedLastRun: false,
      }),
      afterEntryMutation: async () => {
        callbackTranscriptEvents = await loadTranscriptEvents({
          sessionKey: "agent:main:room",
          sessionId: "old-session",
          storePath,
        });
      },
    });
    transcriptUpdates.unsubscribe();

    const stored = loadSessionEntry({ sessionKey: "agent:main:room", storePath });
    expect(stored?.sessionId).toBe("next-session");
    expect(result.previousSessionId).toBe("old-session");
    expect(result.archivedTranscripts).toHaveLength(5);
    expect(result.archivedTranscripts.map((transcript) => transcript.archivedPath)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("old-session.jsonl.reset."),
        expect.stringContaining("usage-family-session.jsonl.reset."),
        expect.stringContaining("checkpoint-session.jsonl.reset."),
        expect.stringContaining("pre-compaction-session.jsonl.reset."),
        expect.stringContaining("post-compaction-session.jsonl.reset."),
      ]),
    );
    expect(transcriptUpdates.files).toContain(result.archivedTranscripts[0]?.archivedPath);
    expect(callbackTranscriptEvents).toEqual([]);
    expect(readArchiveLinesForSession(result, "old-session")).toEqual([
      createTranscriptEventLine("old-session", "before reset old-session"),
    ]);
    expect(readArchiveLinesForSession(result, "usage-family-session")).toEqual([
      createTranscriptEventLine("usage-family-session", "before reset usage-family-session"),
    ]);
    expect(readArchiveLinesForSession(result, "checkpoint-session")).toEqual([
      createTranscriptEventLine("checkpoint-session", "before reset checkpoint-session"),
    ]);
    expect(readArchiveLinesForSession(result, "pre-compaction-session")).toEqual([
      createTranscriptEventLine("pre-compaction-session", "before reset pre-compaction-session"),
    ]);
    expect(readArchiveLinesForSession(result, "post-compaction-session")).toEqual([
      createTranscriptEventLine("post-compaction-session", "before reset post-compaction-session"),
    ]);
    await expect(
      loadTranscriptEvents({ sessionKey: "agent:main:room", sessionId: "old-session", storePath }),
    ).resolves.toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:room",
        sessionId: "usage-family-session",
        storePath,
      }),
    ).resolves.toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:room",
        sessionId: "pre-compaction-session",
        storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("archives old SQLite transcript rows before reset callbacks can fail", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:callback-failure", storePath },
      {
        sessionId: "callback-old-session",
        updatedAt: now,
      },
    );
    await replaceSqliteTranscriptEvents(
      {
        sessionKey: "agent:main:callback-failure",
        sessionId: "callback-old-session",
        storePath,
      },
      [createTranscriptEvent("callback-old-session", "before callback failure")],
    );

    await expect(
      resetSessionEntryLifecycle({
        storePath,
        target: {
          canonicalKey: "agent:main:callback-failure",
          storeKeys: ["agent:main:callback-failure"],
        },
        buildNextEntry: (): SessionEntry => ({
          sessionId: "callback-next-session",
          updatedAt: now + 1,
        }),
        afterEntryMutation: () => {
          throw new Error("callback failed");
        },
      }),
    ).rejects.toThrow("callback failed");

    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:callback-failure",
        sessionId: "callback-old-session",
        storePath,
      }),
    ).resolves.toEqual([]);
    expect(
      fs
        .readdirSync(path.dirname(storePath))
        .filter((file) => file.startsWith("callback-old-session.jsonl.reset.")),
    ).toHaveLength(1);
  });

  it("deletes an entry from SQLite while archiving unreferenced transcript rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:keep", storePath },
      {
        sessionId: "keep-session",
        updatedAt: now,
      },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:delete", storePath },
      {
        sessionId: "delete-session",
        updatedAt: now - 1,
        usageFamilySessionIds: ["delete-session", "delete-ancestor-session"],
      },
    );
    for (const sessionId of ["delete-session", "delete-ancestor-session"]) {
      await replaceSqliteTranscriptEvents(
        { sessionKey: "agent:main:delete", sessionId, storePath },
        [createTranscriptEvent(sessionId, `before delete ${sessionId}`)],
      );
    }
    const transcriptUpdates = recordTranscriptUpdateFiles();

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });
    transcriptUpdates.unsubscribe();

    expect(result.deleted).toBe(true);
    expect(result.deletedSessionId).toBe("delete-session");
    expect(result.archivedTranscripts).toHaveLength(2);
    expect(result.archivedTranscripts.map((transcript) => transcript.archivedPath)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("delete-session.jsonl.deleted."),
        expect.stringContaining("delete-ancestor-session.jsonl.deleted."),
      ]),
    );
    expect(transcriptUpdates.files).toContain(result.archivedTranscripts[0]?.archivedPath);
    expect(readArchiveLinesForSession(result, "delete-session")).toEqual([
      createTranscriptEventLine("delete-session", "before delete delete-session"),
    ]);
    expect(readArchiveLinesForSession(result, "delete-ancestor-session")).toEqual([
      createTranscriptEventLine("delete-ancestor-session", "before delete delete-ancestor-session"),
    ]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:delete",
        sessionId: "delete-session",
        storePath,
      }),
    ).resolves.toEqual([]);
    expect(loadSessionEntry({ sessionKey: "agent:main:delete", storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: "agent:main:keep", storePath })?.sessionId).toBe(
      "keep-session",
    );
  });

  it("deletes transcript search state with archived session rows", async () => {
    const sessionId = "delete-indexed-session";
    await replaceSessionEntry(
      { sessionKey: "agent:main:delete-indexed", storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:delete-indexed", sessionId, storePath },
      [
        {
          type: "message",
          id: "delete-indexed-message",
          parentId: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "remove this searchable transcript" }],
          },
          timestamp: Date.now(),
        } as unknown as TestTranscriptEvent,
      ],
    );
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const readSearchState = () => ({
      fts: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_fts")
          .select("session_id")
          .where("session_id", "=", sessionId),
      ).rows,
      watermarks: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_index_state")
          .select("session_id")
          .where("session_id", "=", sessionId),
      ).rows,
    });

    expect(readSearchState()).toEqual({
      fts: [{ session_id: sessionId }],
      watermarks: [{ session_id: sessionId }],
    });

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete-indexed",
        storeKeys: ["agent:main:delete-indexed"],
      },
    });

    expect(result.deleted).toBe(true);
    expect(readSearchState()).toEqual({ fts: [], watermarks: [] });
  });

  it("durably writes SQLite transcript archives before deleting entry rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:durable-delete", storePath },
      {
        sessionId: "durable-delete-session",
        updatedAt: now,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:durable-delete", sessionId: "durable-delete-session", storePath },
      [createTranscriptEvent("durable-delete-session", "durable archive first")],
    );

    const originalWriteFileSync = fs.writeFileSync;
    const entryObservedDuringArchiveWrite: boolean[] = [];
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      const filePath = String(args[0]);
      if (filePath.includes("durable-delete-session.jsonl.deleted.")) {
        entryObservedDuringArchiveWrite.push(
          loadSessionEntry({ sessionKey: "agent:main:durable-delete", storePath })?.sessionId ===
            "durable-delete-session",
        );
      }
      return originalWriteFileSync(...args);
    });

    try {
      const result = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: {
          canonicalKey: "agent:main:durable-delete",
          storeKeys: ["agent:main:durable-delete"],
        },
      });

      expect(result.deleted).toBe(true);
      expect(result.archivedTranscripts).toHaveLength(1);
      expect(entryObservedDuringArchiveWrite).toEqual([true]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("probes duplicate SQLite transcript archives before deleting entry rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:duplicate-archive", storePath },
      {
        sessionId: "duplicate-archive-session",
        updatedAt: now,
      },
    );
    await replaceSqliteTranscriptEvents(
      {
        sessionKey: "agent:main:duplicate-archive",
        sessionId: "duplicate-archive-session",
        storePath,
      },
      [createTranscriptEvent("duplicate-archive-session", "reuse archive")],
    );
    const archivePath = path.join(
      path.dirname(storePath),
      "duplicate-archive-session.jsonl.deleted.2026-01-01T00-00-00.000Z",
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      `${createTranscriptEventLine("duplicate-archive-session", "reuse archive")}\n`,
      "utf-8",
    );

    const originalReaddirSync = fs.readdirSync;
    const entryObservedDuringDuplicateProbe: boolean[] = [];
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      const dirPath = String(args[0]);
      if (dirPath === path.dirname(storePath)) {
        entryObservedDuringDuplicateProbe.push(
          loadSessionEntry({ sessionKey: "agent:main:duplicate-archive", storePath })?.sessionId ===
            "duplicate-archive-session",
        );
      }
      return originalReaddirSync(...args);
    });

    try {
      const result = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: {
          canonicalKey: "agent:main:duplicate-archive",
          storeKeys: ["agent:main:duplicate-archive"],
        },
      });

      expect(result.deleted).toBe(true);
      expect(result.archivedTranscripts).toEqual([
        {
          archivedPath: archivePath,
          sourcePath: path.join(path.dirname(storePath), "duplicate-archive-session.jsonl"),
        },
      ]);
      expect(entryObservedDuringDuplicateProbe).toEqual([true]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("deletes a SQLite entry without deleting transcripts when archiveTranscript is false", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:delete-entry-only", storePath },
      {
        sessionId: "entry-only-session",
        updatedAt: now,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:delete-entry-only", sessionId: "entry-only-session", storePath },
      [createTranscriptEvent("entry-only-session", "preserve transcript rows")],
    );
    const transcriptUpdates = recordTranscriptUpdateFiles();

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: {
        canonicalKey: "agent:main:delete-entry-only",
        storeKeys: ["agent:main:delete-entry-only"],
      },
    });
    transcriptUpdates.unsubscribe();

    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toEqual([]);
    expect(transcriptUpdates.files).toEqual([]);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:delete-entry-only", storePath }),
    ).toBeUndefined();
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:delete-entry-only",
        sessionId: "entry-only-session",
        storePath,
      }),
    ).resolves.toEqual([createTranscriptEvent("entry-only-session", "preserve transcript rows")]);
  });

  it("deletes SQLite transcript rows for non-archived lifecycle removals", async () => {
    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: "lifecycle-remove-no-archive-session",
      updatedAt: now,
    };
    await replaceSessionEntry({ sessionKey: "agent:main:no-archive-removal", storePath }, entry);
    await replaceSqliteTranscriptEvents(
      {
        sessionKey: "agent:main:no-archive-removal",
        sessionId: "lifecycle-remove-no-archive-session",
        storePath,
      },
      [createTranscriptEvent("lifecycle-remove-no-archive-session", "remove rows without archive")],
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey: "agent:main:no-archive-removal",
          expectedEntry: entry,
          archiveRemovedTranscript: false,
        },
      ],
      maintenanceOverride: { mode: "enforce" },
    });

    expect(result.removedSessionKeys).toEqual(["agent:main:no-archive-removal"]);
    expect(result.archivedTranscriptDirectories).toEqual([]);
    expect(
      readArchiveNames(
        path.dirname(storePath),
        "lifecycle-remove-no-archive-session.jsonl.deleted.",
      ),
    ).toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:no-archive-removal",
        sessionId: "lifecycle-remove-no-archive-session",
        storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("archives shared SQLite transcript rows when any lifecycle removal requests archive", async () => {
    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: "mixed-archive-shared-session",
      updatedAt: now,
    };
    await replaceSessionEntry({ sessionKey: "agent:main:mixed-archive-a", storePath }, entry);
    await replaceSessionEntry({ sessionKey: "agent:main:mixed-archive-b", storePath }, entry);
    await replaceSqliteTranscriptEvents(
      {
        sessionKey: "agent:main:mixed-archive-a",
        sessionId: "mixed-archive-shared-session",
        storePath,
      },
      [createTranscriptEvent("mixed-archive-shared-session", "shared mixed archive")],
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey: "agent:main:mixed-archive-a",
          expectedEntry: entry,
          archiveRemovedTranscript: false,
        },
        {
          sessionKey: "agent:main:mixed-archive-b",
          expectedEntry: entry,
          archiveRemovedTranscript: true,
        },
      ],
      skipMaintenance: true,
    });

    expect(result.removedSessionKeys).toEqual([
      "agent:main:mixed-archive-a",
      "agent:main:mixed-archive-b",
    ]);
    expect(result.archivedTranscriptDirectories).toEqual([path.dirname(storePath)]);
    const archiveNames = readArchiveNames(
      path.dirname(storePath),
      "mixed-archive-shared-session.jsonl.deleted.",
    );
    expect(archiveNames).toHaveLength(1);
    expect(readArchiveLines(path.join(path.dirname(storePath), archiveNames[0] ?? ""))).toEqual([
      createTranscriptEventLine("mixed-archive-shared-session", "shared mixed archive"),
    ]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:mixed-archive-a",
        sessionId: "mixed-archive-shared-session",
        storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("forced maintenance preserves raw SQLite transcript-only rows", async () => {
    await replaceSqliteTranscriptEvents(
      {
        sessionKey: "agent:main:raw-maintenance",
        sessionId: "raw-maintenance-session",
        storePath,
      },
      [createTranscriptEvent("raw-maintenance-session", "raw transcript-only row")],
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      activeSessionKey: "agent:main:raw-maintenance",
      maintenanceOverride: { mode: "enforce" },
    });

    expect(result.archivedTranscriptDirectories).toEqual([]);
    expect(
      readArchiveNames(path.dirname(storePath), "raw-maintenance-session.jsonl.deleted."),
    ).toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:raw-maintenance",
        sessionId: "raw-maintenance-session",
        storePath,
      }),
    ).resolves.toEqual([
      createTranscriptEvent("raw-maintenance-session", "raw transcript-only row"),
    ]);
  });

  it("preserves shared SQLite transcript rows until the final session reference is deleted", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:first", storePath },
      {
        sessionId: "shared-session",
        updatedAt: now,
      },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:second", storePath },
      {
        sessionId: "shared-session",
        updatedAt: now - 1,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:first", sessionId: "shared-session", storePath },
      [createTranscriptEvent("shared-session", "shared transcript")],
    );

    const first = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:first",
        storeKeys: ["agent:main:first"],
      },
    });

    expect(first.deleted).toBe(true);
    expect(first.archivedTranscripts).toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:second",
        sessionId: "shared-session",
        storePath,
      }),
    ).resolves.toEqual([createTranscriptEvent("shared-session", "shared transcript")]);

    const second = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:second",
        storeKeys: ["agent:main:second"],
      },
    });

    expect(second.deleted).toBe(true);
    expect(second.archivedTranscripts).toHaveLength(1);
    expect(readArchiveLines(second.archivedTranscripts[0]?.archivedPath)).toEqual([
      createTranscriptEventLine("shared-session", "shared transcript"),
    ]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:second",
        sessionId: "shared-session",
        storePath,
      }),
    ).resolves.toEqual([]);
  });

  it("preserves raw SQLite entry references during lifecycle cleanup", async () => {
    const sessionId = "raw-shared-session";
    await replaceSessionEntry(
      { sessionKey: "agent:main:cleanup-target", storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:protected-raw-reference", storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:cleanup-target", sessionId, storePath },
      [createTranscriptEvent(sessionId, "cleanup-marker shared transcript")],
    );
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_entries")
        .set({ entry_json: "{not valid json" })
        .where("session_key", "=", "agent:main:protected-raw-reference"),
    );

    const result = await cleanupSessionLifecycleArtifacts({
      storePath,
      sessionKeySegmentPrefix: "cleanup-target",
      transcriptContentMarker: "cleanup-marker",
      orphanTranscriptMinAgeMs: 0,
      nowMs: Date.now() + 1,
    });

    expect(result).toEqual({ archivedTranscriptArtifacts: 0, removedEntries: 1 });
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_entries")
          .select("session_key")
          .where("session_key", "=", "agent:main:cleanup-target"),
      ),
    ).toBeUndefined();
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_entries")
          .select(["entry_json", "session_id"])
          .where("session_key", "=", "agent:main:protected-raw-reference"),
      ),
    ).toEqual({
      entry_json: "{not valid json",
      session_id: sessionId,
    });
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("sessions").select("session_id").where("session_id", "=", sessionId),
      )?.session_id,
    ).toBe(sessionId);
  });
});

function createTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return JSON.parse(createTranscriptEventLine(sessionId, content)) as TestTranscriptEvent;
}

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({
    type: "session",
    id: sessionId,
    content,
  });
}

function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

function readArchiveNames(archiveDirectory: string, prefix: string): string[] {
  if (!fs.existsSync(archiveDirectory)) {
    return [];
  }
  return fs.readdirSync(archiveDirectory).filter((file) => file.startsWith(prefix));
}

function readArchiveLinesForSession(
  result: { archivedTranscripts: Array<{ archivedPath: string }> },
  sessionId: string,
): string[] {
  return readArchiveLines(
    result.archivedTranscripts.find((transcript) =>
      transcript.archivedPath.includes(`${sessionId}.jsonl.`),
    )?.archivedPath,
  );
}

function recordTranscriptUpdateFiles(): { files: string[]; unsubscribe: () => void } {
  const files: string[] = [];
  return {
    files,
    unsubscribe: onInternalSessionTranscriptUpdate((update) => {
      if (update.sessionFile) {
        files.push(update.sessionFile);
      }
    }),
  };
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
}
