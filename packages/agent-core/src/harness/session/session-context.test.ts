import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../messages.js";
import type { SessionTreeEntry } from "../types.js";
import { buildSessionContext, projectSessionEntryMessage } from "./session.js";

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

function bashEntry(
  id: string,
  parentId: string,
  output: string,
  excludeFromContext: boolean,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "bashExecution",
      command: `print ${output}`,
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.parse(timestamp),
      excludeFromContext,
    },
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

function assistantToolEntry(id: string, parentId: string, toolCallId: string): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      api: "openai-responses",
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
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
  };
}

function toolResultEntry(
  id: string,
  parentId: string,
  toolCallId: string,
  content: string,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: Date.parse(timestamp),
    },
  };
}

describe("buildSessionContext", () => {
  it("keeps display-only custom activity out of model input", () => {
    const activity = {
      role: "custom" as const,
      customType: "openclaw.context-compaction",
      content: `Context compacted ${"x".repeat(80_000)}`,
      display: true,
      excludeFromContext: true,
      timestamp: Date.parse(timestamp),
    };
    const runtimeContext = {
      role: "custom" as const,
      customType: "openclaw.runtime-context",
      content: "Model-visible runtime context",
      display: false,
      details: { runtimeContextCarrier: true },
      timestamp: Date.parse(timestamp),
    };
    const activityEntry: SessionTreeEntry = {
      type: "message",
      id: "activity",
      parentId: "initial",
      timestamp,
      message: activity,
    };
    const runtimeContextEntry: SessionTreeEntry = {
      type: "message",
      id: "runtime-context",
      parentId: "activity",
      timestamp,
      message: runtimeContext,
    };
    const entries = [
      userEntry("initial", null, "original request"),
      activityEntry,
      runtimeContextEntry,
      userEntry("latest", "runtime-context", "continue"),
    ];
    const messages = buildSessionContext(entries).messages;

    expect(convertToLlm([activity])).toEqual([]);
    expect(projectSessionEntryMessage(activityEntry)).toBeUndefined();
    expect(projectSessionEntryMessage(runtimeContextEntry)).toBe(runtimeContext);
    expect(messages.map((message) => message.role)).toEqual(["user", "custom", "user"]);
    expect(JSON.stringify(messages)).toContain("Model-visible runtime context");
    expect(JSON.stringify(messages)).not.toContain("Context compacted");
    expect(convertToLlm(messages)).toMatchObject([
      { role: "user", content: "original request" },
      {
        role: "user",
        content: [{ type: "text", text: "Model-visible runtime context" }],
        runtimeContextCarrier: true,
      },
      { role: "user", content: "continue" },
    ]);
    expect(JSON.stringify(entries)).toContain("Context compacted");
  });

  it("keeps private shell executions in history without projecting them into context", () => {
    const hiddenEntry = bashEntry("hidden", "initial", "private shell output", true);
    const visibleEntry = bashEntry("visible", "hidden", "visible shell output", false);
    const entries = [
      userEntry("initial", null, "original request"),
      hiddenEntry,
      visibleEntry,
      userEntry("latest", "visible", "continue"),
    ];

    const messages = buildSessionContext(entries).messages;

    expect(projectSessionEntryMessage(hiddenEntry)).toBeUndefined();
    expect(projectSessionEntryMessage(visibleEntry)).toBe(
      visibleEntry.type === "message" ? visibleEntry.message : undefined,
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "bashExecution", "user"]);
    expect(JSON.stringify(messages)).toContain("visible shell output");
    expect(JSON.stringify(messages)).not.toContain("private shell output");
    expect(JSON.stringify(entries)).toContain("private shell output");
  });

  it("replays only the retained tail and newer entries after compaction", () => {
    const retainedCheckpoint = replayState("openai-responses-compaction", "retained-checkpoint");
    const retainedAnthropicCheckpoint = replayState(
      "anthropic-compaction",
      "retained-anthropic-checkpoint",
    );
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
        "retained-anthropic-checkpoint",
        "retained-checkpoint",
        "retained Anthropic checkpoint",
        retainedAnthropicCheckpoint,
      ),
      assistantEntry(
        "retained-suppression",
        "retained-anthropic-checkpoint",
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
      "assistant",
      "user",
    ]);
    expect(context.messages).toMatchObject([
      { summary: "older context" },
      { content: "retained" },
      { content: [{ text: "retained checkpoint" }] },
      { content: [{ text: "retained Anthropic checkpoint" }] },
      { content: [{ text: "retained suppression" }] },
      { content: [{ text: "post-boundary checkpoint" }] },
      { content: "new turn" },
    ]);
    const assistants = context.messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(assistants[0]).not.toHaveProperty("providerReplay");
    expect(assistants[1]).not.toHaveProperty("providerReplay");
    expect(assistants[2]?.providerReplay).toEqual(retainedSuppression);
    expect(assistants[3]?.providerReplay).toEqual(postBoundaryCheckpoint);
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

  it("retains reset tool results by call occurrence while excluding an orphan", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded", null, "discarded"),
      userEntry("kept", "discarded", "kept"),
      assistantToolEntry("assistant-1", "kept", "call-1"),
      toolResultEntry("result-1", "assistant-1", "call-1", "first result"),
      assistantToolEntry("assistant-2", "result-1", "call-1"),
      toolResultEntry("result-2", "assistant-2", "call-1", "second result"),
      toolResultEntry("orphan", "result-2", "call-1", "orphan result"),
      {
        type: "reset",
        id: "reset",
        parentId: "orphan",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept",
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
    expect(JSON.stringify(context.messages)).toContain("first result");
    expect(JSON.stringify(context.messages)).toContain("second result");
    expect(JSON.stringify(context.messages)).not.toContain("orphan result");
  });

  it("pairs reset results only with calls inside the retained tail", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("discarded-user", null, "discarded question"),
      assistantToolEntry("discarded-assistant", "discarded-user", "call-shared"),
      userEntry("kept", "discarded-assistant", "kept question"),
      toolResultEntry("discarded-result", "kept", "call-shared", "discarded owner result"),
      assistantToolEntry("kept-assistant", "discarded-result", "call-shared"),
      toolResultEntry("kept-result", "kept-assistant", "call-shared", "kept owner result"),
      {
        type: "reset",
        id: "reset",
        parentId: "kept-result",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept",
      },
      userEntry("new", "reset", "new turn"),
    ];

    const context = buildSessionContext(entries);
    const providerMessages = convertToLlm(context.messages);

    expect(providerMessages).toMatchObject([
      { role: "user", content: "kept question" },
      { role: "assistant", content: [{ id: "call-shared" }] },
      { role: "toolResult", toolCallId: "call-shared", content: [{ text: "kept owner result" }] },
      { role: "user", content: "new turn" },
    ]);
    expect(JSON.stringify(providerMessages)).not.toContain("discarded owner result");
  });

  it("keeps tool ownership within the latest reset when resets repeat", () => {
    const entries: SessionTreeEntry[] = [
      userEntry("first-user", null, "first conversation"),
      assistantToolEntry("first-assistant", "first-user", "first-call"),
      toolResultEntry("first-result", "first-assistant", "first-call", "first result"),
      {
        type: "reset",
        id: "first-reset",
        parentId: "first-result",
        timestamp,
        reason: "new",
        firstKeptEntryId: "first-user",
      },
      assistantToolEntry("discarded-assistant", "first-reset", "discarded-call"),
      userEntry("latest-kept", "discarded-assistant", "latest conversation"),
      toolResultEntry(
        "latest-orphan",
        "latest-kept",
        "discarded-call",
        "result from discarded conversation",
      ),
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "latest-orphan",
        timestamp,
        thinkingLevel: "high",
      },
      assistantToolEntry("latest-assistant", "thinking", "latest-call"),
      toolResultEntry("latest-result", "latest-assistant", "latest-call", "latest result"),
      {
        type: "reset",
        id: "latest-reset",
        parentId: "latest-result",
        timestamp,
        reason: "reset",
        firstKeptEntryId: "latest-kept",
      },
      userEntry("new", "latest-reset", "new turn"),
    ];

    const context = buildSessionContext(entries);

    expect(context.thinkingLevel).toBe("high");
    expect(context.messages).toMatchObject([
      { role: "user", content: "latest conversation" },
      { role: "assistant", content: [{ id: "latest-call" }] },
      { role: "toolResult", toolCallId: "latest-call" },
      { role: "user", content: "new turn" },
    ]);
    expect(JSON.stringify(context.messages)).not.toContain("discarded conversation");
  });

  it("uses local frame ownership before unique displaced-result recovery", () => {
    const localResult = toolResultEntry("local-result", "assistant-2", "call-1", "local result");
    const entries: SessionTreeEntry[] = [
      userEntry("kept", null, "kept"),
      assistantToolEntry("assistant-1", "kept", "call-1"),
      assistantToolEntry("assistant-2", "assistant-1", "call-1"),
      localResult,
      toolResultEntry("ambiguous-extra", "local-result", "call-1", "ambiguous extra"),
      {
        type: "reset",
        id: "reset",
        parentId: "ambiguous-extra",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept",
      },
      userEntry("new", "reset", "new turn"),
    ];

    const messages = buildSessionContext(entries).messages;

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(messages[3]).toBe(localResult.type === "message" ? localResult.message : undefined);
    expect(JSON.stringify(messages)).not.toContain("ambiguous extra");
  });

  it("retains a uniquely displaced result in its original branch position", () => {
    const displacedResult = toolResultEntry(
      "displaced-result",
      "intervening-user",
      "call-1",
      "displaced result",
    );
    const entries: SessionTreeEntry[] = [
      userEntry("kept", null, "kept"),
      assistantToolEntry("assistant", "kept", "call-1"),
      userEntry("intervening-user", "assistant", "intervening"),
      displacedResult,
      {
        type: "reset",
        id: "reset",
        parentId: "displaced-result",
        timestamp,
        reason: "new",
        firstKeptEntryId: "kept",
      },
      userEntry("new", "reset", "new turn"),
    ];

    const messages = buildSessionContext(entries).messages;

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "toolResult",
      "user",
    ]);
    expect(messages[3]).toBe(
      displacedResult.type === "message" ? displacedResult.message : undefined,
    );
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
