import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  persistCompactionBoundaryWithSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function isExpectedCompaction(entryId: string, appendedText: string): boolean {
  const lines = appendedText.trimEnd().split("\n");
  if (lines.length !== 1) {
    return false;
  }
  const entry: unknown = JSON.parse(lines[0] ?? "null");
  return (
    typeof entry === "object" &&
    entry !== null &&
    Reflect.get(entry, "type") === "compaction" &&
    Reflect.get(entry, "id") === entryId
  );
}

describe("persistCompactionBoundaryWithSessionEntrySync", () => {
  it("publishes the boundary, count, and byte latch in one commit", async () => {
    const dir = tempDirs.make("openclaw-compaction-boundary-");
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:compaction-boundary",
      storePath: path.join(dir, "sessions.json"),
    };
    const expected = {
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "writer",
    };
    await upsertSessionEntryCore(scope, {
      ...expected,
      compactionCount: 0,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const before = loadTranscriptEventsSync(scope);

    const entryId = persistCompactionBoundaryWithSessionEntrySync(
      {
        ...scope,
        expectedLifecycleRevision: expected.lifecycleRevision,
        expectedWriterRunId: expected.activeWriterRunId,
      },
      {
        append: () => manager.appendCompaction("summary", keptId, 100),
        transcriptByteCompactionLatch: {
          activeBytes: 2048,
          sessionId: scope.sessionId,
          maxBytes: 1024,
        },
        validateAppend: isExpectedCompaction,
      },
    );

    expect(loadTranscriptEventsSync(scope)).toEqual([
      ...before,
      expect.objectContaining({ id: entryId, type: "compaction" }),
    ]);
    expect(loadSessionEntry(scope)).toMatchObject({
      compactionCount: 1,
      transcriptByteCompactionLatch: {
        activeBytes: 2048,
        sessionId: scope.sessionId,
        maxBytes: 1024,
      },
    });
  });

  it("rolls back the boundary and accounting when validation fails", async () => {
    const dir = tempDirs.make("openclaw-compaction-boundary-rollback-");
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:compaction-boundary-rollback",
      storePath: path.join(dir, "sessions.json"),
    };
    const expected = {
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "writer",
    };
    await upsertSessionEntryCore(scope, {
      ...expected,
      compactionCount: 0,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const before = loadTranscriptEventsSync(scope);

    expect(() =>
      persistCompactionBoundaryWithSessionEntrySync(
        {
          ...scope,
          expectedLifecycleRevision: expected.lifecycleRevision,
          expectedWriterRunId: expected.activeWriterRunId,
        },
        {
          append: () => manager.appendCompaction("summary", keptId, 100),
          transcriptByteCompactionLatch: {
            activeBytes: 2048,
            sessionId: scope.sessionId,
            maxBytes: 1024,
          },
          validateAppend: () => false,
        },
      ),
    ).toThrow("Compaction boundary validation failed");

    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).toMatchObject({ compactionCount: 0 });
    expect(loadSessionEntry(scope)?.transcriptByteCompactionLatch).toBeUndefined();
  });

  it("rolls back when the admitted writer closes during validation", async () => {
    const dir = tempDirs.make("openclaw-compaction-boundary-owner-");
    const scope = {
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:compaction-boundary-owner",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      compactionCount: 0,
      updatedAt: 1,
    });
    const manager = SessionManager.open(scope, dir);
    const keptId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
    const before = loadTranscriptEventsSync(scope);
    const ownerClosed = new Error("compaction owner closed");
    let active = true;

    await expect(
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed: () => {
            if (!active) {
              throw ownerClosed;
            }
          },
          withTranscriptWrite: async (run) => await run(),
        },
        async () =>
          persistCompactionBoundaryWithSessionEntrySync(scope, {
            append: () => manager.appendCompaction("summary", keptId, 100),
            transcriptByteCompactionLatch: {
              activeBytes: 2048,
              sessionId: scope.sessionId,
              maxBytes: 1024,
            },
            validateAppend: (entryId, appendedText) => {
              active = false;
              return isExpectedCompaction(entryId, appendedText);
            },
          }),
      ),
    ).rejects.toBe(ownerClosed);

    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).toMatchObject({ compactionCount: 0 });
    expect(loadSessionEntry(scope)?.transcriptByteCompactionLatch).toBeUndefined();
  });
});
