// Covers OpenAI Responses tool-call id normalization for replay safety.
import type { AssistantMessage, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { normalizeOpenAIResponsesToolCallIds } from "./openai.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildAssistantToolCall(rawId: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.5",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 0,
    content: [{ type: "toolCall", id: rawId, name: "gateway", arguments: {} }],
  };
}

function buildToolResult(rawId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: rawId,
    toolName: "gateway",
    content: [],
    isError: false,
    timestamp: 0,
  };
}

function toolCallId(message: AgentMessage | undefined): string {
  const content = (message as { content?: Array<{ type?: unknown; id?: unknown }> } | undefined)
    ?.content;
  const call = content?.find((block) => block.type === "toolCall");
  if (typeof call?.id !== "string") {
    throw new Error("expected assistant tool call id");
  }
  return call.id;
}

function toolResultId(message: AgentMessage | undefined): string {
  const id = (message as { toolCallId?: unknown } | undefined)?.toolCallId;
  if (typeof id !== "string") {
    throw new Error("expected tool result id");
  }
  return id;
}

describe("normalizeOpenAIResponsesToolCallIds", () => {
  it("derives a stable id from the complete native pairing", () => {
    const rawId = "functions.gateway:0|fc_tmp_kegospxl46";
    const first = normalizeOpenAIResponsesToolCallIds([buildAssistantToolCall(rawId)]);
    const second = normalizeOpenAIResponsesToolCallIds([buildAssistantToolCall(rawId)]);

    expect(toolCallId(first[0])).toBe(
      "call_functions_gateway_0_fc_tmp_kegospxl46_8ea5d0ca62|fc_tmp_kegospxl46",
    );
    expect(toolCallId(second[0])).toBe(toolCallId(first[0]));
  });

  it("passes canonical Responses ids through without allocating new messages", () => {
    const messages: AgentMessage[] = [
      buildAssistantToolCall("call_gateway_0|fc_gateway_0"),
      buildToolResult("call_gateway_0|fc_gateway_0"),
    ];

    expect(normalizeOpenAIResponsesToolCallIds(messages)).toBe(messages);
  });

  it("assigns distinct call ids to repeated native Kimi calls across turns", () => {
    const messages: AgentMessage[] = [
      buildAssistantToolCall("functions.gateway:0|fc_tmp_kegospxl46"),
      buildToolResult("functions.gateway:0|fc_tmp_kegospxl46"),
      { role: "user", content: "check again", timestamp: 1 } as AgentMessage,
      buildAssistantToolCall("functions.gateway:0|fc_tmp_btw21n10glg"),
      buildToolResult("functions.gateway:0|fc_tmp_btw21n10glg"),
    ];

    const [firstCall, firstResult, , secondCall, secondResult] =
      normalizeOpenAIResponsesToolCallIds(messages);

    const firstCallId = toolCallId(firstCall);
    const secondCallId = toolCallId(secondCall);
    expect(firstCallId).not.toBe(secondCallId);
    expect(toolResultId(firstResult)).toBe(firstCallId);
    expect(toolResultId(secondResult)).toBe(secondCallId);
  });

  it("normalizes mixed result aliases and incomplete persisted pairings independently", () => {
    const pairedId = "functions.gateway:0|fc_tmp_paired";
    const assistantOnlyId = "functions.read:0|fc_tmp_assistant_only";
    const resultOnlyId = "functions.exec:0|fc_tmp_result_only";
    const aliasedResult = {
      ...buildToolResult(pairedId),
      toolUseId: pairedId,
    } as ToolResultMessage & { toolUseId: string };
    const untouchedUser = { role: "user", content: "continue", timestamp: 1 } as AgentMessage;

    const out = normalizeOpenAIResponsesToolCallIds([
      aliasedResult as AgentMessage,
      buildAssistantToolCall(pairedId),
      untouchedUser,
      buildAssistantToolCall(assistantOnlyId),
      buildToolResult(resultOnlyId),
    ]);

    const normalizedPairedId = toolCallId(out[1]);
    expect(toolResultId(out[0])).toBe(normalizedPairedId);
    expect((out[0] as { toolUseId?: string }).toolUseId).toBe(normalizedPairedId);
    expect(out[2]).toBe(untouchedUser);
    expect(toolCallId(out[3])).toMatch(/^call_[A-Za-z0-9_-]+\|fc_[A-Za-z0-9_-]+$/);
    expect(toolResultId(out[4])).toMatch(/^call_[A-Za-z0-9_-]+\|fc_[A-Za-z0-9_-]+$/);
    expect(toolCallId(out[3])).not.toBe(toolResultId(out[4]));
  });
});
