import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { planSqliteSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-state.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite lifecycle cleanup races", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-cleanup-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
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
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected cleanup-race database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const cleanupNow = Date.now() + 60_000;
    const planned = planSqliteSessionLifecycleArtifactCleanup(database, {
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
    const originalRenameSync = fs.renameSync;
    let refreshed = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      const result = originalRenameSync(...args);
      if (!refreshed && String(args[1]).includes(`${sessionId}.jsonl.deleted.`)) {
        refreshed = true;
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(refreshedEntry), refreshedEntry.updatedAt, sessionKey);
      }
      return result;
    });

    try {
      await expect(
        cleanupSessionLifecycleArtifacts({
          storePath,
          sessionKeySegmentPrefix: "cleanup-race",
          transcriptContentMarker: "cleanup-race-marker",
          orphanTranscriptMinAgeMs: 0,
          nowMs: cleanupNow,
        }),
      ).rejects.toThrow("SQLite lifecycle cleanup entry changed");
    } finally {
      renameSpy.mockRestore();
    }

    expect(refreshed).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(refreshedEntry);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([
      event,
    ]);
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
    await replaceSqliteTranscriptEvents(
      { sessionKey, sessionId: "current-planned-session", storePath },
      [currentEvent],
    );
    await replaceSqliteTranscriptEvents(
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
    await replaceSqliteTranscriptEvents(
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
