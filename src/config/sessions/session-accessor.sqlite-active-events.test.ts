// Active transcript projection tests cover branches, guards, and reset windows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptActiveLeafEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventById,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEventPage,
  SessionTranscriptProjectionUnavailableError,
} from "./session-accessor.sqlite-active-events.js";
import {
  readRecentSessionTranscriptMessageEventsWithGuard,
  readSessionTranscriptMessageEventPageWithGuard,
  readSessionTranscriptMessageEventSnapshotWithGuard,
} from "./session-accessor.sqlite-guarded-message-events.js";
import { readSessionTranscriptGuardState } from "./session-transcript-guard.runtime.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite active transcript event projection", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-active-transcript-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "active-transcript-test",
      sessionKey: "agent:main:active-transcript-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("defers branch rewind rebuilds off history and writer stacks", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "inactive" },
        },
        {
          eventId: "active",
          parentId: "root",
          message: { role: "assistant", content: "active" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 2, needs_rebuild: 1 });

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "root",
      "active",
    ]);
    expect(readSessionTranscriptActiveLeafEvents(scope)).toEqual([
      expect.objectContaining({ id: "active" }),
    ]);
    expect(readSessionTranscriptGuardState(scope, "root")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: true,
      guardLeafEntryId: "active",
      hasTranscriptEvents: true,
    });
    expect(readSessionTranscriptGuardState(scope, "active")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: true,
      guardLeafEntryId: "active",
      hasTranscriptEvents: true,
    });
    expect(readSessionTranscriptGuardState(scope, "inactive")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: "active",
      hasTranscriptEvents: true,
    });
    expect(readSessionTranscriptGuardState(scope, "missing")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: "active",
      hasTranscriptEvents: true,
    });
    expect(page.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(page.totalMessages).toBe(2);
    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_event_count, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_event_count: 2, active_message_count: 2, needs_rebuild: 0 });
    expect(
      database.db
        .prepare(
          "SELECT active_position, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
    ).toEqual([
      { active_position: 0, event_seq: 1, message_position: 0 },
      { active_position: 1, event_seq: 3, message_position: 1 },
    ]);

    const activeRows = database.db
      .prepare(
        `SELECT event.event_json
         FROM session_transcript_active_events AS active
         JOIN transcript_events AS event
           ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
         ORDER BY active.active_position`,
      )
      .all(scope.sessionId) as Array<{ event_json: string }>;
    expect(readSessionTranscriptActiveStats(scope)).toEqual({
      eventCount: activeRows.length,
      sizeBytes: activeRows.reduce(
        (total, row) => total + Buffer.byteLength(row.event_json, "utf8") + 1,
        0,
      ),
    });
  });

  it("defers mixed legacy and canonical rebuilds off request stacks", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "canonical-root",
          parentId: null,
          message: { role: "user", content: "canonical" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    await appendTranscriptEvent(scope, {
      id: "legacy-child",
      parentId: "canonical-root",
      message: { role: "assistant", content: "legacy" },
    });

    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 1, needs_rebuild: 1 });

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.totalMessages).toBe(1);
    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "canonical-root",
    ]);
    expect(readSessionTranscriptMessageEventById(scope, "legacy-child")).toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 1, needs_rebuild: 0 });
  });

  it("skips oversized tail rows before materializing a bounded message page", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "small", parentId: null, message: { role: "user", content: "keep" } },
        {
          eventId: "oversized",
          parentId: "small",
          message: { role: "assistant", content: "x".repeat(16_384) },
        },
      ],
      touchSessionEntry: false,
    });

    const page = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 512,
      maxMessages: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });

    expect(page.scannedMessages).toBe(2);
    expect(page.serializedBytes).toBeLessThanOrEqual(512);
    expect(page.events.map(({ event }) => (event as { id?: unknown }).id)).toEqual(["small"]);
  });

  it("fails fast and schedules maintenance when out-of-band state is dirty", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });

    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 0 });
  });

  it("projects reset kept-tail and post-boundary messages without rewriting raw positions", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-tool",
          parentId: "kept-user",
          message: { role: "toolResult", content: `hidden tool ${"x".repeat(2_000)}` },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-tool",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);
    expect(page.events.map((entry) => entry.seq)).toEqual([2, 4, 5]);
    expect(page.totalMessages).toBe(3);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(3);
    expect(readSessionTranscriptMessageEventById(scope, "old")).toBeUndefined();
    expect(readSessionTranscriptMessageEventById(scope, "kept-tool")).toBeUndefined();

    const recent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1_024,
      maxLines: 10,
      maxMessages: 3,
    });
    expect(recent.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "newer-compaction",
      parentId: "post-reset",
      timestamp: "2026-07-22T00:01:00.000Z",
      summary: "newer boundary shadows reset",
      firstKeptEntryId: "old",
      tokensBefore: 10,
    });
    expect(
      readRecentSessionTranscriptMessageEventsWithGuard(scope, {
        maxBytes: 1_024,
        maxLines: 1,
        maxMessages: 1,
      }).guardLeafEntryId,
    ).toBe("newer-compaction");
    expect(
      readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1_024,
        maxLines: 1,
        maxMessages: 1,
      }).activeLeafEntryId,
    ).toBe("newer-compaction");
    expect(
      readSessionTranscriptGuardState(scope, "newer-compaction").expectedEntryOnGuardPath,
    ).toBe(true);
    expect(readSessionTranscriptGuardState(scope, "post-reset").expectedEntryOnGuardPath).toBe(
      true,
    );
    expect(readSessionTranscriptActiveLeafEvents(scope)).toEqual([
      expect.objectContaining({ id: "newer-compaction" }),
    ]);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(5);
    expect(readSessionTranscriptMessageEventById(scope, "old")).toBeDefined();
  });

  it("uses the logical active leaf while reset fences stale tokens", async () => {
    expect(readSessionTranscriptMessageEventSnapshotWithGuard(scope)).toMatchObject({
      events: [],
      guardKind: "empty",
      guardLeafEntryId: null,
      hasTranscriptEvents: false,
      totalMessages: 0,
    });

    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "hidden-old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "retained",
          parentId: "hidden-old",
          message: { role: "assistant", content: "retained" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "retained-reset",
      parentId: "retained",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "retained",
    });

    for (const page of [
      readSessionTranscriptMessageEventSnapshotWithGuard(scope),
      readRecentSessionTranscriptMessageEventsWithGuard(scope, {
        maxBytes: 1_024,
        maxLines: 10,
        maxMessages: 10,
      }),
      readSessionTranscriptMessageEventPageWithGuard(scope, { maxMessages: 10, offset: 0 }),
    ]) {
      expect(page).toMatchObject({
        guardKind: "identified",
        guardLeafEntryId: "retained-reset",
        hasTranscriptEvents: true,
        totalMessages: 1,
      });
    }
    expect(readSessionTranscriptGuardState(scope, "retained").expectedEntryOnGuardPath).toBe(false);
    expect(readSessionTranscriptGuardState(scope, "retained-reset").expectedEntryOnGuardPath).toBe(
      true,
    );
    expect(readSessionTranscriptGuardState(scope, "hidden-old").expectedEntryOnGuardPath).toBe(
      false,
    );

    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "empty-reset",
      parentId: "retained-reset",
      timestamp: "2026-07-22T00:01:00.000Z",
      reason: "new",
    });
    expect(readSessionTranscriptGuardState(scope, "retained-reset")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: "empty-reset",
      hasTranscriptEvents: true,
    });
    expect(readSessionTranscriptGuardState(scope, "empty-reset").expectedEntryOnGuardPath).toBe(
      true,
    );

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "first-post-reset",
          parentId: "empty-reset",
          message: { role: "user", content: "new" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "custom",
      id: "background-append",
      parentId: "first-post-reset",
      timestamp: "2026-07-22T00:02:00.000Z",
    });
    expect(readSessionTranscriptGuardState(scope, "first-post-reset")).toEqual({
      kind: "identified",
      expectedEntryOnGuardPath: true,
      guardLeafEntryId: "background-append",
      hasTranscriptEvents: true,
    });
    expect(
      readSessionTranscriptGuardState(scope, "background-append").expectedEntryOnGuardPath,
    ).toBe(true);
    expect(readSessionTranscriptGuardState(scope, "hidden-old").expectedEntryOnGuardPath).toBe(
      false,
    );
  });

  it("does not fall back behind an unidentified logical leaf", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "identified-old", message: { role: "user", content: "old" } },
        {
          eventId: "unidentified-tail",
          parentId: "identified-old",
          message: { role: "assistant", content: "tail" },
        },
      ],
      touchSessionEntry: false,
    });
    openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env })
      .db.prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .run(scope.sessionId, "unidentified-tail");

    expect(readSessionTranscriptMessageEventSnapshotWithGuard(scope)).toMatchObject({
      guardKind: "unavailable",
      guardLeafEntryId: null,
    });
    expect(readSessionTranscriptGuardState(scope)).toEqual({
      kind: "unavailable",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents: true,
    });
    for (const expectedEntryId of ["identified-old", "unidentified-tail"]) {
      expect(readSessionTranscriptGuardState(scope, expectedEntryId)).toEqual({
        kind: "unavailable",
        expectedEntryOnGuardPath: false,
        guardLeafEntryId: null,
        hasTranscriptEvents: true,
      });
    }
  });

  it("rejects structural append tokens when an explicit leaf clears visible messages", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "old-append-parent",
          parentId: null,
          message: { role: "user", content: "old" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "empty-leaf-control",
      parentId: "old-append-parent",
      targetId: null,
      appendParentId: "old-append-parent",
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    expect(readSessionTranscriptMessageEventSnapshotWithGuard(scope)).toMatchObject({
      events: [],
      guardKind: "empty",
      guardLeafEntryId: null,
      hasTranscriptEvents: true,
      totalMessages: 0,
    });
    expect(
      readSessionTranscriptGuardState(scope, "old-append-parent").expectedEntryOnGuardPath,
    ).toBe(false);
    expect(
      readSessionTranscriptGuardState(scope, "empty-leaf-control").expectedEntryOnGuardPath,
    ).toBe(false);
    expect(readSessionTranscriptGuardState(scope)).toEqual({
      kind: "empty",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents: true,
    });
  });

  it("recomputes a cached reset window after a branch-changing message", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept" },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "post reset" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(3);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "branch-message",
          parentId: "old",
          message: { role: "assistant", content: "branched" },
        },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });
    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "branch-message",
    ]);
  });
});
