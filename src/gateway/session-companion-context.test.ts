import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as activeTranscriptEvents from "../config/sessions/session-accessor.sqlite-active-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function createScope(prefix: string) {
  const stateDir = tempDirs.make(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionId: `${prefix}-session`,
    sessionKey: `agent:main:${prefix}`,
  };
}

describe("session companion context", () => {
  it("distinguishes a missing session from an empty selected transcript", async () => {
    const missing = createScope("companion-context-missing");
    await expect(defaultSessionCompanionContextReader.read(missing)).resolves.toEqual({
      kind: "missing",
    });

    const empty = createScope("companion-context-empty");
    await upsertSessionEntryCore(empty, { sessionId: empty.sessionId, updatedAt: 1 });
    const result = await defaultSessionCompanionContextReader.read(empty);
    expect(result).toEqual({
      kind: "ready",
      context: {
        empty: true,
        messages: [],
        sessionId: empty.sessionId,
      },
    });
  });

  it("reads a bounded active SQLite tail without decoding old transcript rows", async () => {
    const scope = createScope("companion-context-tail");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const messages = Array.from({ length: 201 }, (_, index) => ({
      eventId: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message: {
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `message ${index}`,
        timestamp: index,
      },
    }));
    await persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: true });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
      .run(scope.sessionId);

    const result = await defaultSessionCompanionContextReader.read(scope);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.context.messages).toHaveLength(40);
    expect(result.context.messages.at(0)).toEqual({
      role: "assistant",
      text: "message 161",
      ts: 161,
    });
    expect(result.context.messages.at(-1)).toEqual({
      role: "user",
      text: "message 200",
      ts: 200,
    });
  });

  it("pages past a tool-heavy tail while retaining the selected session's latest user turn", async () => {
    const scope = createScope("companion-context-tools");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const usefulMessages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `useful ${index}`,
      timestamp: index,
    }));
    const toolMessages = Array.from({ length: 400 }, (_, index) => ({
      role: "toolResult" as const,
      content: `tool result ${index}`,
      timestamp: usefulMessages.length + index,
    }));
    const transcriptMessages = [
      ...usefulMessages,
      ...toolMessages,
      { role: "user" as const, content: "visible latest question", timestamp: 450 },
    ].map((message, index) => ({
      eventId: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message,
    }));
    await persistSessionTranscriptTurn(scope, {
      messages: transcriptMessages,
      touchSessionEntry: true,
    });

    const result = await defaultSessionCompanionContextReader.read(scope);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.context.messages).toHaveLength(40);
    expect(result.context.messages.at(-1)?.text).toBe("visible latest question");
    expect(result.context.messages.some((message) => message.text.startsWith("tool result"))).toBe(
      false,
    );
  });

  it("keeps complete recent context when older tool rows exhaust the scan byte budget", async () => {
    const scope = createScope("companion-context-byte-budget");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const recentMessages = Array.from({ length: 128 }, (_, index) => {
      const isContextMessage = index % 9 === 0;
      return {
        eventId: `recent-${index}`,
        parentId: index === 0 ? "older-tool" : `recent-${index - 1}`,
        message: isContextMessage
          ? { role: "user" as const, content: `useful ${index}`, timestamp: index }
          : { role: "toolResult" as const, content: "x".repeat(7800), timestamp: index },
      };
    });
    const messages = [
      {
        eventId: "older-tool",
        parentId: null,
        message: { role: "toolResult" as const, content: "x".repeat(200_000), timestamp: -1 },
      },
      ...recentMessages,
    ];
    await persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: true });

    const result = await defaultSessionCompanionContextReader.read(scope);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.context.messages.length).toBeGreaterThan(0);
    expect(result.context.messages.at(-1)?.text).toBe("useful 126");
    expect(result.context.messages.every((message) => message.text.startsWith("useful"))).toBe(
      true,
    );
  });

  it.each([
    { expectedKind: "ready", unsupportedCount: 4095 },
    { expectedKind: "unavailable", unsupportedCount: 4096 },
  ] as const)(
    "fails closed only when unsupported roles exceed the bounded scan ($unsupportedCount)",
    async ({ expectedKind, unsupportedCount }) => {
      const scope = createScope(`companion-context-unsupported-${unsupportedCount}`);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const messages = [
        {
          eventId: "visible-user",
          parentId: null,
          message: { role: "user" as const, content: "authoritative question", timestamp: 1 },
        },
        ...Array.from({ length: unsupportedCount }, (_, index) => ({
          eventId: `custom-${index}`,
          parentId: index === 0 ? "visible-user" : `custom-${index - 1}`,
          message: {
            role: "custom" as const,
            customType: "test-context",
            content: `unsupported ${index}`,
            timestamp: index + 2,
          },
        })),
      ];
      await persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: true });

      const result = await defaultSessionCompanionContextReader.read(scope);

      expect(result.kind).toBe(expectedKind);
      if (result.kind === "ready") {
        expect(result.context.messages.map((message) => message.text)).toEqual([
          "authoritative question",
        ]);
      }
    },
  );

  it("returns unavailable instead of backfilling past an oversized latest user message", async () => {
    const scope = createScope("companion-context-oversized-latest");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "older",
          parentId: null,
          message: { role: "user" as const, content: "stale older question", timestamp: 1 },
        },
        {
          eventId: "oversized",
          parentId: "older",
          message: {
            role: "user" as const,
            content: "x".repeat(1024 * 1024),
            timestamp: 2,
          },
        },
      ],
      touchSessionEntry: true,
    });

    await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("uses the contiguous newest suffix when an older message exceeds the read budget", async () => {
    const scope = createScope("companion-context-oversized-older");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "stale",
          parentId: null,
          message: { role: "user" as const, content: "stale older question", timestamp: 1 },
        },
        {
          eventId: "oversized",
          parentId: "stale",
          message: {
            role: "assistant" as const,
            content: "x".repeat(1024 * 1024),
            timestamp: 2,
          },
        },
        {
          eventId: "recent-question",
          parentId: "oversized",
          message: { role: "user" as const, content: "recent question", timestamp: 3 },
        },
        {
          eventId: "recent-answer",
          parentId: "recent-question",
          message: { role: "assistant" as const, content: "recent answer", timestamp: 4 },
        },
      ],
      touchSessionEntry: true,
    });

    await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
      kind: "ready",
      context: {
        empty: false,
        messages: [
          { role: "user", text: "recent question", ts: 3 },
          { role: "assistant", text: "recent answer", ts: 4 },
        ],
        sessionId: scope.sessionId,
      },
    });
  });

  it("rejects context assembled across different transcript snapshots", async () => {
    const scope = createScope("companion-context-snapshot-fence");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const page = vi
      .spyOn(activeTranscriptEvents, "readSessionTranscriptBoundedMessageTailPage")
      .mockReturnValueOnce({
        activeLeafEntryId: "leaf-1",
        events: [
          {
            event: {
              type: "message",
              id: "message-1",
              parentId: null,
              message: { role: "user", content: "stable context", timestamp: 1 },
            },
            eventSeq: 1,
            seq: 1,
          },
        ],
        newestContiguousEventCount: 1,
        scannedMessages: 1,
        serializedBytes: 128,
        snapshot: { generation: "generation-1", indexedSeq: 1 },
        totalMessages: 1,
      })
      .mockReturnValueOnce({
        activeLeafEntryId: "leaf-1",
        events: [],
        newestContiguousEventCount: 0,
        scannedMessages: 0,
        serializedBytes: 0,
        snapshot: { generation: "generation-2", indexedSeq: 1 },
        totalMessages: 1,
      });

    await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("keeps transcript-visible messages across compaction", async () => {
    const scope = createScope("companion-context-compaction");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "discarded",
          parentId: null,
          message: { role: "user" as const, content: "discarded context", timestamp: 1 },
        },
        {
          eventId: "retained",
          parentId: "discarded",
          message: { role: "user" as const, content: "retained context", timestamp: 2 },
        },
      ],
      touchSessionEntry: true,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction",
      parentId: "retained",
      timestamp: "2026-08-11T00:00:00.000Z",
      summary: "older context was compacted",
      firstKeptEntryId: "retained",
      tokensBefore: 100,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "answer",
          parentId: "compaction",
          message: { role: "assistant" as const, content: "recent answer", timestamp: 3 },
        },
        {
          eventId: "question",
          parentId: "answer",
          message: { role: "user" as const, content: "visible current question", timestamp: 4 },
        },
      ],
      touchSessionEntry: true,
    });

    const result = await defaultSessionCompanionContextReader.read(scope);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.context.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "discarded context"],
      ["user", "retained context"],
      ["assistant", "recent answer"],
      ["user", "visible current question"],
    ]);
  });

  it("ignores oversized non-message compaction details", async () => {
    const scope = createScope("companion-context-oversized-boundary");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "retained",
          parentId: null,
          message: { role: "user" as const, content: "retained context", timestamp: 1 },
        },
      ],
      touchSessionEntry: true,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "oversized-compaction",
      parentId: "retained",
      timestamp: "2026-08-11T00:00:00.000Z",
      summary: "small summary",
      firstKeptEntryId: "retained",
      tokensBefore: 100,
      details: { payload: "x".repeat(1024 * 1024) },
    });

    await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
      kind: "ready",
      context: {
        empty: false,
        messages: [{ role: "user", text: "retained context", ts: 1 }],
        sessionId: scope.sessionId,
      },
    });
  });

  it("returns unavailable rather than an empty context while the active projection is stale", async () => {
    const scope = createScope("companion-context-unavailable");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "question",
          parentId: null,
          message: { role: "user" as const, content: "visible question", timestamp: 1 },
        },
      ],
      touchSessionEntry: true,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    await expect(defaultSessionCompanionContextReader.read(scope)).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
