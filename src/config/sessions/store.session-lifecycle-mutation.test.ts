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
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle,
  listSessionEntries,
  loadTranscriptEvents,
  loadSessionEntry,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";
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

  it("resets the live entry while keeping previous SQLite history searchable", async () => {
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
        sessionId === "old-session"
          ? createSearchableTranscriptEvent(sessionId, "foreverneedle before reset")
          : createTranscriptEvent(sessionId, `before reset ${sessionId}`),
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
    expect(result.archivedTranscripts).toEqual([]);
    expect(transcriptUpdates.files).toEqual([]);
    expect(callbackTranscriptEvents).toEqual([
      createSearchableTranscriptEvent("old-session", "foreverneedle before reset"),
    ]);
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:room",
        entry: expect.objectContaining({ sessionId: "next-session" }),
      },
    ]);
    expect(readArchiveNames(path.dirname(storePath), "old-session.jsonl.reset.")).toEqual([]);
    expect(
      searchSessionTranscripts({
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        query: "foreverneedle",
        sessionKeys: ["agent:main:room"],
      }).hits,
    ).toEqual([
      expect.objectContaining({
        sessionId: "old-session",
        sessionKey: "agent:main:room",
      }),
    ]);
    await expect(
      loadTranscriptEvents({ sessionKey: "agent:main:room", sessionId: "old-session", storePath }),
    ).resolves.toHaveLength(1);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:room",
        sessionId: "usage-family-session",
        storePath,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:room",
        sessionId: "pre-compaction-session",
        storePath,
      }),
    ).resolves.toHaveLength(1);
  });

  it("keeps old SQLite rows when a post-reset callback fails", async () => {
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
    ).resolves.toHaveLength(1);
    expect(
      readArchiveNames(path.dirname(storePath), "callback-old-session.jsonl.reset."),
    ).toHaveLength(0);
  });

  it("explicit delete archives and removes every retained reset generation", async () => {
    const sessionKey = "agent:main:delete-history";
    const sessionIds = ["delete-history-one", "delete-history-two", "delete-history-three"];
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "delete-history-one", updatedAt: 1 },
    );
    for (const [index, sessionId] of sessionIds.entries()) {
      await replaceSqliteTranscriptEvents({ sessionId, sessionKey, storePath }, [
        createSearchableTranscriptEvent(sessionId, `deleteforever generation ${index + 1}`),
      ]);
      const nextSessionId = sessionIds[index + 1];
      if (nextSessionId) {
        await resetSessionEntryLifecycle({
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          buildNextEntry: () => ({ sessionId: nextSessionId, updatedAt: index + 2 }),
        });
      }
    }
    expect(
      searchSessionTranscripts({
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        query: "deleteforever",
        sessionKeys: [sessionKey],
      }).hits,
    ).toHaveLength(3);

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toHaveLength(3);
    expect(listSessionEntries({ storePath })).toEqual([]);
    for (const sessionId of sessionIds) {
      await expect(loadTranscriptEvents({ sessionId, sessionKey, storePath })).resolves.toEqual([]);
      expect(readArchiveNames(path.dirname(storePath), `${sessionId}.jsonl.deleted.`)).toHaveLength(
        1,
      );
    }
    expect(
      searchSessionTranscripts({
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        query: "deleteforever",
        sessionKeys: [sessionKey],
      }).hits,
    ).toEqual([]);
  });

  it("explicit delete aborts while admitted work owns a retained generation", async () => {
    const sessionKey = "agent:main:delete-admitted-history";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "admit-old", updatedAt: 1 });
    await replaceSqliteTranscriptEvents({ sessionId: "admit-old", sessionKey, storePath }, [
      createSearchableTranscriptEvent("admit-old", "admitted generation"),
    ]);
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "admit-live", updatedAt: 2 }),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["admit-old"],
      assertAllowed: () => {},
    });
    try {
      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: true,
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).rejects.toThrow(/work is in flight/);
      expect(listSessionEntries({ storePath })).toHaveLength(1);
      await expect(
        loadTranscriptEvents({ sessionId: "admit-old", sessionKey, storePath }),
      ).resolves.toHaveLength(1);
    } finally {
      admission.release();
    }

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(result.deleted).toBe(true);
    // Only admit-old carries transcript events; admit-live never wrote any.
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(readArchiveNames(path.dirname(storePath), "admit-old.jsonl.deleted.")).toHaveLength(1);
    expect(listSessionEntries({ storePath })).toEqual([]);
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

  it("fsyncs SQLite transcript archives through their writable descriptor before deletion", async () => {
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

    const originalRenameSync = fs.renameSync;
    const entryObservedDuringArchiveRename: boolean[] = [];
    const openSpy = vi.spyOn(fs, "openSync");
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      const archivePath = String(args[1]);
      if (archivePath.includes("durable-delete-session.jsonl.deleted.")) {
        entryObservedDuringArchiveRename.push(
          loadSessionEntry({ sessionKey: "agent:main:durable-delete", storePath })?.sessionId ===
            "durable-delete-session",
        );
      }
      return originalRenameSync(...args);
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
      expect(entryObservedDuringArchiveRename).toEqual([true]);
      const archiveTempOpenIndexes = openSpy.mock.calls.flatMap((args, index) =>
        String(args[0]).includes("durable-delete-session.jsonl.deleted.") && args[1] === "wx"
          ? [index]
          : [],
      );
      expect(archiveTempOpenIndexes).toHaveLength(1);
      const archiveTempOpenIndex = archiveTempOpenIndexes[0] ?? -1;
      expect(openSpy.mock.calls[archiveTempOpenIndex]?.[1]).toBe("wx");
      expect(fsyncSpy).toHaveBeenCalledWith(openSpy.mock.results[archiveTempOpenIndex]?.value);
    } finally {
      renameSpy.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
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

function createSearchableTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return {
    id: `message-${sessionId}`,
    message: { role: "user", content },
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "message",
  } as TestTranscriptEvent;
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
