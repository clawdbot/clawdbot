import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeReplayToolCallIdsForStream } from "./attempt.tool-call-normalization.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function requireAssistantMessage(message: AgentMessage | undefined): AssistantMessage {
  if (!message || message.role !== "assistant") {
    throw new Error(`expected assistant message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function requireToolResultMessage(message: AgentMessage | undefined): ToolResultMessage {
  if (!message || message.role !== "toolResult") {
    throw new Error(`expected toolResult message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function assistantToolUseSummaries(message: AgentMessage | undefined) {
  const assistant = requireAssistantMessage(message);
  return assistant.content.map((content) => {
    const record = content as unknown as Record<string, unknown>;
    if (record.type !== "toolUse") {
      throw new Error(`expected toolUse content, got ${String(record.type)}`);
    }
    return {
      type: record.type,
      id: record.id,
      name: record.name,
    };
  });
}

function toolResultSummary(message: AgentMessage | undefined) {
  const toolResult = requireToolResultMessage(message);
  const record = toolResult as unknown as Record<string, unknown>;
  return {
    role: toolResult.role,
    toolCallId: toolResult.toolCallId,
    toolUseId: record.toolUseId,
    toolName: toolResult.toolName,
    isError: toolResult.isError,
  };
}

describe("sanitizeReplayToolCallIdsForStream", () => {
  it("drops orphaned tool results after strict id sanitization", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_function_av7cbkigmk7x1",
        toolUseId: "call_function_av7cbkigmk7x1",
        toolName: "read",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      } as never,
    ];

    expect(
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode: "strict",
        repairToolUseResultPairing: true,
      }),
    ).toStrictEqual([]);
  });

  it("keeps matched assistant and tool-result ids aligned", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawId,
        toolUseId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeReplayToolCallIdsForStream({
      messages,
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
  });

  it("synthesizes missing tool results after strict id sanitization", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolUse", id: rawId, name: "read", input: { path: "." } },
            { type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } },
          ],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
      { type: "toolUse", id: "callmissing", name: "exec" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
    expect(toolResultSummary(out[2])).toEqual({
      role: "toolResult",
      toolCallId: "callmissing",
      toolUseId: undefined,
      toolName: "exec",
      isError: true,
    });
  });

  it("synthesizes missing tool results when repair is enabled", () => {
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_missing", name: "exec", input: { cmd: "true" } }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callmissing",
      toolUseId: undefined,
      toolName: "exec",
      isError: true,
    });
  });

  it("keeps real tool results for aborted assistant spans", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "partial" }],
          isError: false,
        } as never,
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(requireAssistantMessage(out[0]).stopReason).toBe("aborted");
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" },
    ]);
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "callfunctionav7cbkigmk7x1",
      toolUseId: "callfunctionav7cbkigmk7x1",
      toolName: "read",
      isError: false,
    });
  });
});
