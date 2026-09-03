import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  cleanupSessionLifecycleArtifactsCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  afterMaterialize: undefined as (() => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      archiveMaterializationHook.afterMaterialize?.();
      return result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite lifecycle cleanup reclamation", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(
      tempDirs.make("openclaw-session-cleanup-reclamation-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
  });

  afterEach(() => {
    archiveMaterializationHook.afterMaterialize = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("keeps the event loop responsive while committing a large transcript", async () => {
    const rows = 100_000;
    const now = Date.now();
    const sessionKey = "agent:main:cleanup-reclamation-large";
    const sessionId = "cleanup-reclamation-large";
    const unrelatedKey = "agent:main:cleanup-reclamation-unrelated";
    const unrelatedSessionId = "cleanup-reclamation-unrelated";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: now - 600_000 });
    await replaceSessionEntry(
      { sessionKey: unrelatedKey, storePath },
      { sessionId: unrelatedSessionId, updatedAt: now },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        type: "metadata",
        runId: "cleanup-reclamation-marker",
        timestamp: new Date(now - 600_000).toISOString(),
      },
    ]);
    const database = openDatabase(storePath);
    const insert = database.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const eventJson = JSON.stringify({
      type: "metadata",
      runId: "cleanup-reclamation-marker",
      timestamp: new Date(now - 600_000).toISOString(),
    });
    const initialSeq = Number(
      (
        database.db
          .prepare("SELECT max(seq) AS seq FROM transcript_events WHERE session_id = ?")
          .get(sessionId) as { seq: number | bigint }
      ).seq,
    );
    // sqlite-allow-raw -- bulk fixture setup stays outside the measured cleanup commit.
    database.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index < rows; index += 1) {
        insert.run(sessionId, initialSeq + index, eventJson, now - 600_000 + index);
      }
      insert.run(
        unrelatedSessionId,
        0,
        JSON.stringify({ type: "metadata", runId: "unrelated" }),
        now,
      );
      // sqlite-allow-raw -- commits the deterministic fixture before measurement.
      database.db.exec("COMMIT");
    } catch (error) {
      // sqlite-allow-raw -- releases the failed fixture transaction.
      database.db.exec("ROLLBACK");
      throw error;
    }

    const samples: number[] = [];
    let previous = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    archiveMaterializationHook.afterMaterialize = () => {
      previous = performance.now();
      heartbeat = setInterval(() => {
        const current = performance.now();
        samples.push(current - previous);
        previous = current;
      }, 10);
    };

    let result: Awaited<ReturnType<typeof cleanupSessionLifecycleArtifactsCore>>;
    try {
      result = await cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "cleanup-reclamation-large",
        transcriptContentMarker: "cleanup-reclamation-marker",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs: now,
      });
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }

    const maxGapMs = Math.max(...samples);
    if (process.env.OPENCLAW_TEST_RECLAMATION_LOG === "1") {
      process.stdout.write(
        `${JSON.stringify({ owner: "lifecycle-cleanup", rows, maxGapMs, result })}\n`,
      );
    }
    expect(result).toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 1 });
    expect(samples.length).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(500);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: unrelatedKey, storePath })).toMatchObject({
      sessionId: unrelatedSessionId,
    });
    expect(
      database.db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ count: 0 });
    expect(
      database.db
        .prepare(
          "SELECT archive_sha256, published_at FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId),
    ).toMatchObject({
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
    });
  }, 120_000);
});

function openDatabase(storePath: string) {
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected lifecycle-cleanup reclamation database path");
  }
  return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
}
