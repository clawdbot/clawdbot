// `sessions cleanup --fix-missing` must never delete a session whose transcript
// merely cannot be READ (corrupt database file, SQLITE_BUSY against a live
// gateway, EACCES, ...): unreadable is not missing. Only a transcript that
// reads successfully and holds no message records may be pruned.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getLogger } from "../../logging/logger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import type { TranscriptEvent } from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cfg = {} as OpenClawConfig;

describe("sessions cleanup --fix-missing unreadable transcripts", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-fix-missing-unreadable-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  function messageEvent(id: string, content: string): TranscriptEvent {
    return {
      type: "message",
      id,
      parentId: null,
      message: { role: "user", content },
    } as unknown as TranscriptEvent;
  }

  function agentDatabasePath(): string {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected an agent database path");
    }
    return databasePath;
  }

  function tearTranscriptRow(sessionId: string, seq: number): void {
    // Simulate a partially written row (process died mid-flush): the row still
    // exists but its JSON is truncated, so the probe's parse-all reader throws
    // on it — one concrete, deterministic member of the "transcript read fails
    // after the store has loaded" failure class (SQLITE_BUSY/EACCES are the
    // transient cousins caught by the same branch).
    const database = openOpenClawAgentDatabase({ agentId: "main", path: agentDatabasePath() });
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = ?")
      .run(sessionId, seq);
  }

  async function runFixMissingCleanup(): Promise<void> {
    await runSessionsCleanup({
      cfg,
      opts: { fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
  }

  it("keeps the entry when the transcript read fails on a torn row", async () => {
    const sessionKey = "agent:main:torn-row";
    const sessionId = "torn-row-session";
    // Fresh updatedAt: isolate the missing-transcript probe from stale pruning,
    // so a surviving session proves the probe kept it, not its recency.
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      messageEvent("first", "keep me"),
      messageEvent("second", "and me"),
      messageEvent("third", "me too"),
    ]);
    // Sanity: the database file exists before we tear the middle row.
    expect(fs.existsSync(agentDatabasePath())).toBe(true);
    tearTranscriptRow(sessionId, 1);
    const warnSpy = vi.spyOn(getLogger(), "warn");

    await runFixMissingCleanup();

    // Regression: the failed read was classified as "missing" and the entry was
    // deleted, orphaning the two perfectly readable message rows on disk.
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(warnSpy).toHaveBeenCalledWith(
      "sessions cleanup --fix-missing: transcript unreadable, keeping entry",
      expect.objectContaining({ sessionKey, sessionId }),
    );
    warnSpy.mockRestore();
  });

  it("still prunes entries whose transcript reads successfully with no message records", async () => {
    const sessionKey = "agent:main:empty-transcript";
    const sessionId = "empty-transcript-session";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, []);

    await runFixMissingCleanup();

    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("keeps entries whose transcript holds message records", async () => {
    const sessionKey = "agent:main:healthy-transcript";
    const sessionId = "healthy-transcript-session";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      messageEvent("first", "still here"),
    ]);

    await runFixMissingCleanup();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
  });
});
