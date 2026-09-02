import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadTranscriptEventRowsAfterSeqSync,
  readSessionTranscriptRestorableMessageSnapshot,
  replaceTranscriptEvents,
  rewriteTranscriptEventRowsExact,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite restorable transcript messages", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(async () => {
    const stateDir = tempDirs.make("openclaw-restorable-messages-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "restorable-messages",
      sessionKey: "agent:main:restorable-messages",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function ids() {
    return readSessionTranscriptRestorableMessageSnapshot(scope).events.map(
      ({ event }) => (event as { id?: unknown }).id,
    );
  }

  function retainedIds() {
    return readSessionTranscriptRestorableMessageSnapshot(scope).retainedEvents.map(
      ({ event }) => (event as { id?: unknown }).id,
    );
  }

  it("returns active and inactive branch messages once in storage order", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: "one" },
      },
      { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "two" } },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        message: { role: "assistant", content: "two" },
      },
      { type: "message", id: "u3", parentId: "a2", message: { role: "user", content: "three" } },
      {
        type: "leaf",
        id: "rewind-leaf",
        parentId: "u3",
        targetId: "a1",
      },
    ]);

    expect(ids()).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(retainedIds()).toEqual(["u1", "a1", "u2", "a2", "u3"]);
  });

  it("keeps reset ancestry retained until a newer compaction makes it restorable", async () => {
    const baseEvents = [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
      {
        type: "message",
        id: "pre-reset-tip",
        parentId: "old",
        message: { role: "assistant", content: "retired branch" },
      },
      {
        type: "message",
        id: "kept-user",
        parentId: "old",
        message: { role: "user", content: "kept" },
      },
      {
        type: "message",
        id: "kept-tool",
        parentId: "kept-user",
        message: { role: "toolResult", content: "not replayed" },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-tool",
        message: { role: "assistant", content: "kept answer" },
      },
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        firstKeptEntryId: "kept-user",
      },
      {
        type: "message",
        id: "post-reset",
        parentId: "reset-boundary",
        message: { role: "user", content: "new active branch" },
      },
      {
        type: "message",
        id: "post-reset-inactive",
        parentId: "reset-boundary",
        message: { role: "assistant", content: "new inactive branch" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "post-reset-inactive",
        targetId: "post-reset",
      },
    ];
    await replaceTranscriptEvents(scope, baseEvents);

    expect(ids()).toEqual(["kept-user", "kept-assistant", "post-reset", "post-reset-inactive"]);
    expect(retainedIds()).toEqual([
      "old",
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "post-reset",
      "post-reset-inactive",
    ]);

    await replaceTranscriptEvents(scope, [
      ...baseEvents,
      {
        type: "compaction",
        id: "newer-compaction",
        parentId: "post-reset",
        firstKeptEntryId: "post-reset",
      },
    ]);

    expect(ids()).toEqual([
      "old",
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "post-reset",
      "post-reset-inactive",
    ]);
    expect(retainedIds()).toEqual([
      "old",
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "post-reset",
      "post-reset-inactive",
    ]);
  });

  it("retains live compaction checkpoint sources through their fork boundaries", async () => {
    const preCompactionScope = { ...scope, sessionId: "pre-compaction-session" };
    const postCompactionScope = { ...scope, sessionId: "post-compaction-session" };
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "current",
        parentId: null,
        message: { role: "user", content: "current" },
      },
    ]);
    await replaceTranscriptEvents(preCompactionScope, [
      { type: "session", id: preCompactionScope.sessionId, version: 3 },
      {
        type: "message",
        id: "pre-one",
        parentId: null,
        message: { role: "user", content: "pre one" },
      },
      {
        type: "message",
        id: "pre-leaf",
        parentId: "pre-one",
        message: { role: "assistant", content: "pre leaf" },
      },
      {
        type: "message",
        id: "pre-after",
        parentId: "pre-leaf",
        message: { role: "user", content: "outside checkpoint" },
      },
    ]);
    await replaceTranscriptEvents(postCompactionScope, [
      { type: "session", id: postCompactionScope.sessionId, version: 3 },
      {
        type: "message",
        id: "post-one",
        parentId: null,
        message: { role: "user", content: "post one" },
      },
      {
        type: "message",
        id: "post-leaf",
        parentId: "post-one",
        message: { role: "assistant", content: "post leaf" },
      },
      {
        type: "message",
        id: "post-after",
        parentId: "post-leaf",
        message: { role: "user", content: "outside checkpoint" },
      },
    ]);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-retention",
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: {
            sessionId: preCompactionScope.sessionId,
            leafId: "pre-leaf",
          },
          postCompaction: {
            sessionId: postCompactionScope.sessionId,
            entryId: "post-leaf",
          },
        },
      ],
    });

    expect(ids()).toEqual(["current"]);
    expect(retainedIds()).toEqual(["current", "pre-one", "pre-leaf", "post-one", "post-leaf"]);
    expect(readSessionTranscriptRestorableMessageSnapshot(scope).artifactRetentionComplete).toBe(
      true,
    );
  });

  it("marks file-backed checkpoint retention incomplete", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "current",
        parentId: null,
        message: { role: "user", content: "current" },
      },
    ]);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId: "legacy-checkpoint-retention",
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: {
            sessionId: "legacy-pre-session",
            sessionFile: "/tmp/pre-compaction.jsonl",
          },
          postCompaction: {
            sessionId: "legacy-post-session",
            sessionFile: "/tmp/post-compaction.jsonl",
          },
        },
      ],
    });

    expect(readSessionTranscriptRestorableMessageSnapshot(scope)).toMatchObject({
      artifactRetentionComplete: false,
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "current" }) })],
    });
  });

  it("marks an unreadable checkpoint source incomplete while retaining a valid fallback", async () => {
    const postCompactionScope = { ...scope, sessionId: "post-fallback-session" };
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "current",
        parentId: null,
        message: { role: "user", content: "current" },
      },
    ]);
    await replaceTranscriptEvents(postCompactionScope, [
      { type: "session", id: postCompactionScope.sessionId, version: 3 },
      {
        type: "message",
        id: "post-fallback",
        parentId: null,
        message: { role: "assistant", content: "fallback" },
      },
    ]);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: Date.now(),
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-fallback-retention",
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          preCompaction: {
            sessionId: "missing-pre-session",
            leafId: "missing-pre-leaf",
          },
          postCompaction: {
            sessionId: postCompactionScope.sessionId,
            entryId: "post-fallback",
          },
        },
      ],
    });

    const snapshot = readSessionTranscriptRestorableMessageSnapshot(scope);
    expect(snapshot.artifactRetentionComplete).toBe(false);
    expect(snapshot.retainedEvents.map(({ event }) => (event as { id?: unknown }).id)).toEqual([
      "current",
      "post-fallback",
    ]);
  });

  it("rotates generation for exact-row rewrites without changing max sequence", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "assistant",
        parentId: null,
        message: { role: "assistant", content: "before" },
      },
    ]);
    const before = readSessionTranscriptRestorableMessageSnapshot(scope);
    const row = loadTranscriptEventRowsAfterSeqSync(scope, -1).find(
      ({ event }) => (event as { id?: unknown }).id === "assistant",
    );
    if (!row) {
      throw new Error("expected assistant transcript row");
    }

    await expect(
      rewriteTranscriptEventRowsExact(scope, {
        expectedGeneration: before.generation,
        rows: [
          {
            event: {
              ...(row.event as Record<string, unknown>),
              message: { role: "assistant", content: "after" },
            },
            expectedEventJson: JSON.stringify(row.event),
            seq: row.seq,
          },
        ],
      }),
    ).resolves.toEqual({ generation: expect.any(String) });

    const after = readSessionTranscriptRestorableMessageSnapshot(scope);
    expect(after.generation).not.toBe(before.generation);
    expect(after.maxSeq).toBe(before.maxSeq);
    expect(after.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: "assistant",
          message: { role: "assistant", content: "after" },
        }),
      }),
    ]);
    expect(after.retainedEvents).toEqual(after.events);
  });
});
