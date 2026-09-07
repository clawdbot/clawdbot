// Coverage for provider replay tool-call sanitization.

import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnSanitizeMalformedToolCalls,
} from "./attempt-tool-call-replay-sanitization.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

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
    return { type: record.type, id: record.id, name: record.name };
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
  it("skips strict stream id sanitization when provider policy opts out", () => {
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: false,
        isOpenAIResponsesApi: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        isOpenAIResponsesApi: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyReplayToolCallIdSanitizer({
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        isOpenAIResponsesApi: true,
      }),
    ).toBe(false);
  });

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

  it("pairs repeated raw ids before assigning provider-safe occurrence ids", () => {
    const rawId = "exec_0";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: rawId, name: "exec", input: { cmd: "first" } }],
        } as never,
        {
          role: "assistant",
          content: [{ type: "toolUse", id: rawId, name: "exec", input: { cmd: "second" } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "exec",
          content: [{ type: "text", text: "second result" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "exec0", name: "exec" },
    ]);
    expect(toolResultSummary(out[1])).toMatchObject({
      toolCallId: "exec0",
      isError: true,
    });
    expect(assistantToolUseSummaries(out[2])).toEqual([
      { type: "toolUse", id: "exec02", name: "exec" },
    ]);
    expect(toolResultSummary(out[3])).toEqual({
      role: "toolResult",
      toolCallId: "exec02",
      toolUseId: "exec02",
      toolName: "exec",
      isError: false,
    });
    expect(requireToolResultMessage(out[3]).content).toEqual([
      { type: "text", text: "second result" },
    ]);
  });

  it("keeps same-turn repeated calls and results aligned after id rewriting", () => {
    const rawId = "exec_0";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolUse", id: rawId, name: "exec", input: { cmd: "first" } },
            { type: "toolUse", id: rawId, name: "exec", input: { cmd: "second" } },
          ],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "exec",
          content: [{ type: "text", text: "first result" }],
          isError: false,
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "exec",
          content: [{ type: "text", text: "second result" }],
          isError: false,
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(assistantToolUseSummaries(out[0])).toEqual([
      { type: "toolUse", id: "exec0", name: "exec" },
      { type: "toolUse", id: "exec02", name: "exec" },
    ]);
    expect(toolResultSummary(out[1])).toMatchObject({
      toolCallId: "exec0",
      toolUseId: "exec0",
      isError: false,
    });
    expect(toolResultSummary(out[2])).toMatchObject({
      toolCallId: "exec02",
      toolUseId: "exec02",
      isError: false,
    });
  });

  it("preserves signed-thinking replay ids when requested by provider policy", () => {
    const rawId = "call_1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
            { type: "toolUse", id: rawId, name: "read", input: { path: "." } },
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
      preserveReplaySafeThinkingToolCallIds: true,
      repairToolUseResultPairing: true,
    });

    expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(requireAssistantMessage(out[0]).content[1]).toMatchObject({
      type: "toolUse",
      id: "call_1",
      name: "read",
    });
    expect(toolResultSummary(out[1])).toEqual({
      role: "toolResult",
      toolCallId: "call_1",
      toolUseId: "call_1",
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

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("preserves valid Bedrock tool calls while merging appended user turns", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    };
    const baseFn = vi.fn((_model: unknown, _context: unknown) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
      preserveSignatures: true,
      dropThinkingBlocks: false,
      appendOnlyRuntimeContext: true,
    });
    void wrapped(
      { api: "bedrock-converse-stream" } as never,
      {
        messages: [
          assistant,
          { role: "user", content: "earlier" },
          { role: "user", content: "continue" },
        ],
      } as never,
    );
    const context = baseFn.mock.calls[0]?.[1] as { messages: AgentMessage[] };
    expect(context.messages[0]).toBe(assistant);
    expect(context.messages).toEqual([
      assistant,
      {
        role: "user",
        content: [
          { type: "text", text: "earlier" },
          { type: "text", text: "continue" },
        ],
        timestamp: undefined,
      },
    ]);
  });

  it("keeps valid non-Responses replay inputs pass-through", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
    ];
    const baseFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) =>
      createFakeStream({
        events: [],
        resultMessage: { role: "assistant", content: "ok" },
      }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["image_generate"]),
      undefined,
      "openai",
    );

    void wrapped({ api: "openai" } as never, { messages } as never, {} as never);

    const forwardedContext = baseFn.mock.calls[0]?.[1] as {
      messages?: AgentMessage[];
    };
    expect(forwardedContext.messages).toBe(messages);
  });

  it("repairs OpenAI Responses pairing even when replay inputs do not change", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_2",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "assistant",
        stopReason: "stop",
        content: "Worked: the QA lighthouse image completed.",
      } as never,
    ];
    const baseFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) =>
      createFakeStream({
        events: [],
        resultMessage: { role: "assistant", content: "ok" },
      }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["image_generate"]),
      undefined,
      "openai",
    );

    void wrapped({ api: "openai-responses" } as never, { messages } as never, {} as never);

    const forwardedContext = baseFn.mock.calls[0]?.[1] as {
      messages?: AgentMessage[];
    };
    expect(forwardedContext.messages?.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(forwardedContext.messages?.[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_mock_image_generate_2",
      toolName: "image_generate",
      isError: true,
      content: [{ type: "text", text: "aborted" }],
    });
  });
});

describe("sanitizeOpenAIResponsesReplayForStream", () => {
  it("preserves completed encrypted reasoning after an async tool fragment and steering", () => {
    const assistant: Omit<AssistantMessage, "content"> = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      responseId: "resp_async",
      stopReason: "toolUse",
      timestamp: 1,
      usage: {
        input: 1,
        output: 1,
        totalTokens: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const reasoning: AssistantMessage = {
      ...assistant,
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_async",
            summary: [],
            encrypted_content: "synthetic-completed-reasoning",
          }),
        },
      ],
    };
    const messages: AgentMessage[] = [
      { role: "user", content: "Check the status", timestamp: 0 },
      {
        ...assistant,
        content: [
          { type: "toolCall", id: "call_async", name: "lookup", arguments: {}, async: true },
        ],
      },
      reasoning,
      {
        role: "toolResult",
        toolCallId: "call_async",
        toolName: "lookup",
        content: [{ type: "text", text: "Ready" }],
        isError: false,
        timestamp: 2,
      },
      { role: "user", content: "Include the queued update", timestamp: 3 },
    ];

    const replay = sanitizeOpenAIResponsesReplayForStream(messages);
    expect(replay).toContainEqual(reasoning);
    expect(replay.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
  });

  it("normalizes live responses continuations before pi-ai splits ids", () => {
    const longCallId = `call_${"x".repeat(120)}`;
    const longItemId = `notfc_${"y".repeat(120)}`;
    const rawToolCallId = `${longCallId}|${longItemId}`;
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: rawToolCallId, name: "noop", arguments: {} }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawToolCallId,
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeOpenAIResponsesReplayForStream(messages);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const toolCall = assistant.content.find(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { id?: unknown }).id === "string",
    ) as { id: string } | undefined;

    expect(toolCall?.id).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(toolCall?.id).not.toBe(rawToolCallId);
    expect(toolCall?.id).not.toContain("|");
    expect((out[1] as Extract<AgentMessage, { role: "toolResult" }>).toolCallId).toBe(toolCall?.id);
  });

  it("preserves canonical same-model reasoning pairs", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal",
            thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
          },
          { type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call_123|fc_123",
        toolName: "noop",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    expect(sanitizeOpenAIResponsesReplayForStream(messages)).toBe(messages);
  });

  it("repairs dangling OpenAI Responses tool calls from async resume replay", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Image generation check. Generate an image of a QA lighthouse.",
      } as never,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_1",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call_mock_image_generate_1",
        toolName: "image_generate",
        content: [{ type: "text", text: "Background task started for image generation." }],
        isError: false,
      } as never,
      {
        role: "custom",
        content: "Image generation started; wait for completion.",
      } as never,
      {
        role: "user",
        content: "The image is ready for the original chat.",
      } as never,
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call_mock_image_generate_2",
            name: "image_generate",
            arguments: { prompt: "QA lighthouse" },
          },
        ],
      } as never,
      {
        role: "assistant",
        stopReason: "stop",
        content: "Worked: the QA lighthouse image completed.",
      } as never,
    ];

    const out = sanitizeOpenAIResponsesReplayForStream(messages);
    const danglingAssistant = out[5] as AssistantMessage;
    const danglingToolCall = danglingAssistant.content.find(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall",
    ) as { id?: string } | undefined;
    const danglingResult = out[6] as Extract<AgentMessage, { role: "toolResult" }>;

    expect(out.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "custom",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(danglingResult.toolCallId).toBe(danglingToolCall?.id);
    expect(danglingResult.toolName).toBe("image_generate");
    expect(danglingResult.isError).toBe(true);
    expect(danglingResult.content).toEqual([{ type: "text", text: "aborted" }]);
  });
});
