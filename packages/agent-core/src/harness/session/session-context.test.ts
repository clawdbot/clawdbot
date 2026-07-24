import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
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

describe("buildSessionContext", () => {
  it("keeps invalid custom and branch timestamps non-fatal during replay", () => {
    const entries: SessionTreeEntry[] = [
      {
        type: "custom_message",
        id: "custom",
        parentId: null,
        timestamp: "9999-12-31",
        customType: "note",
        content: "custom content",
        display: true,
      },
      {
        type: "branch_summary",
        id: "branch",
        parentId: "custom",
        timestamp: "01/02/03",
        fromId: "branch-root",
        summary: "branch content",
      },
    ];

    expect(buildSessionContext(entries).messages).toMatchObject([
      { role: "custom", content: "custom content" },
      { role: "branchSummary", summary: "branch content" },
    ]);
    expect(buildSessionContext(entries).messages[0]).not.toHaveProperty("timestamp");
    expect(buildSessionContext(entries).messages[1]).not.toHaveProperty("timestamp");
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
      { summary: "older context", retainedMessageCount: 1 },
      { content: "retained" },
      { content: "new turn" },
    ]);
    const retainedBoundary = Symbol.for("openclaw.compactionRetainedBoundary");
    expect(
      (context.messages[0] as AgentMessage & { [retainedBoundary]?: string })[retainedBoundary],
    ).toBe("compaction");
    expect(
      (context.messages[1] as AgentMessage & { [retainedBoundary]?: string })[retainedBoundary],
    ).toBe("compaction");
    expect(
      (context.messages[2] as AgentMessage & { [retainedBoundary]?: string })[retainedBoundary],
    ).toBeUndefined();
  });

  it("preserves the retained range when a compaction timestamp is invalid", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("kept", null, "retained"),
      {
        type: "compaction",
        id: "compaction",
        parentId: "kept",
        timestamp: "9999-12-31",
        summary: "older context",
        firstKeptEntryId: "kept",
        tokensBefore: 123,
      },
      userEntry("new", "compaction", "new turn"),
    ];

    const messages = buildSessionContext(entries).messages;

    expect(messages).toMatchObject([
      { role: "compactionSummary", retainedMessageCount: 1 },
      { role: "user", content: "retained" },
      { role: "user", content: "new turn" },
    ]);
    expect(messages[0]).not.toHaveProperty("timestamp");
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
