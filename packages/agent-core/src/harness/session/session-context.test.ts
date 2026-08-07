import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { buildSessionContext } from "./session.js";

const timestamp = "2026-07-17T00:00:00.000Z";

function userEntry(id: string, parentId: string | null, content: string): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
  };
}

const RESET_TOOL_CALL_TYPES = ["toolCall", "toolUse", "functionCall"] as const;
const RESET_TOOL_RESULT_ID_FIELDS = [
  "toolCallId",
  "toolUseId",
  "tool_call_id",
  "tool_use_id",
  "callId",
  "call_id",
] as const;
const RESET_PAIR_VARIANTS = RESET_TOOL_CALL_TYPES.flatMap((blockType) =>
  RESET_TOOL_RESULT_ID_FIELDS.map((resultField) => ({ blockType, resultField })),
);

describe("buildSessionContext", () => {
  it("replays only the retained tail and newer entries after compaction", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("old", null, "discarded"),
      userEntry("kept", "old", "retained"),
      {
        type: "model_change",
        id: "model",
        parentId: "kept",
        timestamp,
        provider: "test-provider",
        modelId: "test-model",
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "model",
        timestamp,
        summary: "older context",
        firstKeptEntryId: "kept",
        tokensBefore: 123,
      },
      userEntry("new", "compaction", "new turn"),
    ];

    const context = buildSessionContext(entries);

    expect(context).toMatchObject({
      thinkingLevel: "off",
      model: { provider: "test-provider", modelId: "test-model" },
    });
    expect(context.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(context.messages).toMatchObject([
      { summary: "older context" },
      { content: "retained" },
      { content: "new turn" },
    ]);
  });

  it("treats the latest reset as a hard cut with pairing-aware kept tool results", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      userEntry("kept-user", "discarded", "kept question"),
      {
        type: "message",
        id: "kept-assistant-tool",
        parentId: "kept-user",
        timestamp,
        message: {
          role: "assistant",
          api: "openai-responses",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "message",
        id: "kept-tool",
        parentId: "kept-assistant-tool",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "paired tool result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "message",
        id: "kept-orphan-tool",
        parentId: "kept-tool",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "read",
          content: [{ type: "text", text: "orphan tool result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-orphan-tool",
        timestamp,
        message: {
          role: "assistant",
          api: "openai-responses",
          content: [{ type: "text", text: "kept answer" }],
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "kept-assistant",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      userEntry("new", "reset", "new turn"),
    ];

    const context = buildSessionContext(entries);

    expect(context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(context.messages)).toContain("kept question");
    expect(JSON.stringify(context.messages)).toContain("paired tool result");
    expect(JSON.stringify(context.messages)).toContain("kept answer");
    expect(JSON.stringify(context.messages)).toContain("new turn");
    expect(JSON.stringify(context.messages)).not.toContain("discarded");
    expect(JSON.stringify(context.messages)).not.toContain("orphan tool result");
  });

  it.each(RESET_PAIR_VARIANTS)(
    "retains a paired $blockType/$resultField tool result across reset replay and excludes orphans",
    ({ blockType, resultField }) => {
      const entries: SessionTreeEntry[] = [
        userEntry("discarded", null, "discarded"),
        userEntry("kept-user", "discarded", "kept question"),
        {
          type: "message",
          id: "kept-assistant-tool",
          parentId: "kept-user",
          timestamp,
          message: {
            role: "assistant",
            api: "anthropic-messages",
            content: [{ type: blockType, id: "call-1", name: "read", arguments: {} }],
            provider: "test-provider",
            model: "test-model",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.parse(timestamp),
          } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
        },
        {
          type: "message",
          id: "kept-tool",
          parentId: "kept-assistant-tool",
          timestamp,
          message: {
            role: "toolResult",
            [resultField]: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "paired tool result" }],
            isError: false,
            timestamp: Date.parse(timestamp),
          } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
        },
        {
          type: "message",
          id: "kept-orphan-tool",
          parentId: "kept-tool",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "orphan-call",
            toolName: "read",
            content: [{ type: "text", text: "orphan tool result" }],
            isError: false,
            timestamp: Date.parse(timestamp),
          },
        },
        {
          type: "reset",
          id: "reset",
          parentId: "kept-orphan-tool",
          timestamp,
          reason: "new",
          firstKeptEntryId: "kept-user",
        },
        userEntry("new", "reset", "new turn"),
      ];

      const context = buildSessionContext(entries);

      expect(context.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "user",
      ]);
      expect(JSON.stringify(context.messages)).toContain("paired tool result");
      expect(JSON.stringify(context.messages)).not.toContain("orphan tool result");
      expect(JSON.stringify(context.messages)).not.toContain("discarded");
    },
  );

  it("matches repeated aliased tool-call ids by occurrence across reset replay", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("kept-user", null, "kept question"),
      {
        type: "message",
        id: "kept-assistant-tool-1",
        parentId: "kept-user",
        timestamp,
        message: {
          role: "assistant",
          api: "anthropic-messages",
          content: [{ type: "toolUse", id: "call-1", name: "read", input: {} }],
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.parse(timestamp),
        } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
      },
      {
        type: "message",
        id: "kept-tool-1",
        parentId: "kept-assistant-tool-1",
        timestamp,
        message: {
          role: "toolResult",
          tool_use_id: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "first paired result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
      },
      {
        type: "message",
        id: "kept-assistant-tool-2",
        parentId: "kept-tool-1",
        timestamp,
        message: {
          role: "assistant",
          api: "anthropic-messages",
          content: [{ type: "functionCall", id: "call-1", name: "read", arguments: {} }],
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.parse(timestamp),
        } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
      },
      {
        type: "message",
        id: "kept-tool-2",
        parentId: "kept-assistant-tool-2",
        timestamp,
        message: {
          role: "toolResult",
          call_id: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "second paired result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
      },
      {
        type: "message",
        id: "kept-orphan-tool",
        parentId: "kept-tool-2",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "third orphan result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "kept-orphan-tool",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      userEntry("new", "reset", "new turn"),
    ];

    const context = buildSessionContext(entries);

    expect(context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(JSON.stringify(context.messages)).toContain("first paired result");
    expect(JSON.stringify(context.messages)).toContain("second paired result");
    expect(JSON.stringify(context.messages)).not.toContain("third orphan result");
  });

  it("lets the latest compaction shadow an earlier reset boundary", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("old", null, "old"),
      {
        type: "reset",
        id: "reset",
        parentId: "old",
        timestamp,
        reason: "reset",
      },
      userEntry("post-reset", "reset", "post reset"),
      {
        type: "compaction",
        id: "compaction",
        parentId: "post-reset",
        timestamp,
        summary: "latest summary",
        firstKeptEntryId: "post-reset",
        tokensBefore: 10,
      },
    ];

    expect(buildSessionContext(entries).messages).toMatchObject([
      { role: "compactionSummary", summary: "latest summary" },
      { role: "user", content: "post reset" },
    ]);
  });
});
