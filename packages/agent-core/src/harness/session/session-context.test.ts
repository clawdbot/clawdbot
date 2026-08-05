import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import {
  buildSessionContext,
  buildSessionRecoveryContext,
  projectSessionReplayWindow,
} from "./session.js";

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

describe("buildSessionContext", () => {
  it("projects valid and invalid retained-tail positions conservatively", () => {
    expect(
      projectSessionReplayWindow({
        boundaryPosition: 3,
        boundaryType: "compaction",
        entryCount: 5,
        firstKeptPosition: 1,
      }),
    ).toEqual({
      boundaryPosition: 3,
      boundaryType: "compaction",
      postBoundaryPosition: 4,
      retainedStartPosition: 1,
    });
    expect(
      projectSessionReplayWindow({
        boundaryPosition: 3,
        boundaryType: "reset",
        entryCount: 5,
        firstKeptPosition: 4,
      }),
    ).toEqual({
      boundaryPosition: 3,
      boundaryType: "reset",
      postBoundaryPosition: 4,
      retainedStartPosition: 3,
    });
  });

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

  it("treats the latest reset as a hard cut with a user/assistant-only kept tail", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      userEntry("kept-user", "discarded", "kept question"),
      {
        type: "message",
        id: "kept-tool",
        parentId: "kept-user",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "hidden tool result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-tool",
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

    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(context.messages)).toContain("kept question");
    expect(JSON.stringify(context.messages)).toContain("kept answer");
    expect(JSON.stringify(context.messages)).toContain("new turn");
    expect(JSON.stringify(context.messages)).not.toContain("discarded");
    expect(JSON.stringify(context.messages)).not.toContain("hidden tool result");
  });

  it("pairs retained reset tool results only for safeguard recovery", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      userEntry("kept-user", "discarded", "kept question"),
      {
        type: "message",
        id: "kept-assistant",
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
        id: "kept-result",
        parentId: "kept-assistant",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "paired result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "message",
        id: "unrelated-result",
        parentId: "kept-result",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "unrelated",
          toolName: "read",
          content: [{ type: "text", text: "unrelated result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "unrelated-result",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      userEntry("new", "reset", "new turn"),
    ];

    expect(buildSessionContext(entries).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    const recovered = buildSessionRecoveryContext(entries).messages;
    expect(recovered.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(JSON.stringify(recovered)).toContain("paired result");
    expect(JSON.stringify(recovered)).not.toContain("unrelated result");
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

  it("keeps a compaction tool call and result pair without duplicating its summary", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      userEntry("kept", "discarded", "inspect"),
      {
        type: "message",
        id: "assistant-tool",
        parentId: "kept",
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
        id: "tool-result",
        parentId: "assistant-tool",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: Date.parse(timestamp),
        },
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "tool-result",
        timestamp,
        summary: "summary-once",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
      },
      userEntry("post", "compaction", "continue"),
    ];

    const messages = buildSessionContext(entries).messages;

    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(JSON.stringify(messages).match(/summary-once/g)).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("discarded");
  });

  it("keeps only the summary and post-boundary entries when firstKeptEntryId is invalid", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      {
        type: "compaction",
        id: "compaction",
        parentId: "discarded",
        timestamp,
        summary: "summary",
        firstKeptEntryId: "missing",
        tokensBefore: 10,
      },
      userEntry("post", "compaction", "continue"),
    ];

    expect(buildSessionContext(entries).messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "continue" },
    ]);
  });
});
