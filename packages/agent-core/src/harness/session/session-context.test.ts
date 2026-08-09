import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";
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

function assistantEntry(
  id: string,
  parentId: string | null,
  content: string,
  providerReplay?: ProviderReplayState,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      api: "openai-responses",
      content: [{ type: "text", text: content }],
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
      ...(providerReplay ? { providerReplay } : {}),
    },
  };
}

function replayState(type: string, data: string): ProviderReplayState {
  return {
    v: 1,
    type,
    data,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.6-luna",
    baseUrlHash: "route-a",
  };
}

describe("buildSessionContext", () => {
  it("replays only the retained tail and newer entries after compaction", () => {
    const retainedCheckpoint = replayState("openai-responses-compaction", "retained-checkpoint");
    const retainedSuppression = replayState("openai-responses-compaction-suppression", "rejected");
    const postBoundaryCheckpoint = replayState(
      "openai-responses-compaction",
      "post-boundary-checkpoint",
    );
    const entries: SessionTreeEntry[] = [
      userEntry("old", null, "discarded"),
      userEntry("kept", "old", "retained"),
      assistantEntry("retained-checkpoint", "kept", "retained checkpoint", retainedCheckpoint),
      assistantEntry(
        "retained-suppression",
        "retained-checkpoint",
        "retained suppression",
        retainedSuppression,
      ),
      {
        type: "model_change",
        id: "model",
        parentId: "retained-suppression",
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
      assistantEntry(
        "post-checkpoint",
        "compaction",
        "post-boundary checkpoint",
        postBoundaryCheckpoint,
      ),
      userEntry("new", "post-checkpoint", "new turn"),
    ];

    const context = buildSessionContext(entries);

    expect(context).toMatchObject({
      thinkingLevel: "off",
      model: { provider: "test-provider", modelId: "test-model" },
    });
    expect(context.messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(context.messages).toMatchObject([
      { summary: "older context" },
      { content: "retained" },
      { content: [{ text: "retained checkpoint" }] },
      { content: [{ text: "retained suppression" }] },
      { content: [{ text: "post-boundary checkpoint" }] },
      { content: "new turn" },
    ]);
    const assistants = context.messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(assistants[0]).not.toHaveProperty("providerReplay");
    expect(assistants[1]?.providerReplay).toEqual(retainedSuppression);
    expect(assistants[2]?.providerReplay).toEqual(postBoundaryCheckpoint);
  });

  it("treats the latest reset as a hard cut with a user/assistant-only kept tail", () => {
    const retainedCheckpoint = replayState("openai-responses-compaction", "reset-checkpoint");
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
      assistantEntry("kept-assistant", "kept-tool", "kept answer", retainedCheckpoint),
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
    const keptAssistant = context.messages.find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(keptAssistant).not.toHaveProperty("providerReplay");
    expect(
      (
        keptAssistant as AssistantMessage & {
          [key: symbol]: true | undefined;
        }
      )[Symbol.for("openclaw.sessionHistoryPrelude")],
    ).toBe(true);
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
