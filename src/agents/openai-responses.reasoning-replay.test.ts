// Verifies OpenAI Responses replay preserves reasoning and response item ids.
import type { AssistantMessage, Model, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { stream } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";

function buildModel(): Model<"openai-responses"> {
  return {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function extractInput(payload: Record<string, unknown> | undefined) {
  return Array.isArray(payload?.input) ? payload.input : [];
}

function extractInputTypes(input: unknown[]) {
  return input
    .map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined,
    )
    .filter((t): t is string => typeof t === "string");
}

function extractInputMessages(input: unknown[]) {
  return input.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "message",
  );
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildReasoningPart(id = "rs_test") {
  return {
    type: "thinking" as const,
    thinking: "internal",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      summary: [],
    }),
  };
}

function buildAssistantMessage(params: {
  stopReason: AssistantMessage["stopReason"];
  content: AssistantMessage["content"];
}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: ZERO_USAGE,
    stopReason: params.stopReason,
    timestamp: Date.now(),
    content: params.content,
  };
}

async function runAbortedOpenAIResponsesStream(params: {
  messages: Array<
    AssistantMessage | ToolResultMessage | { role: "user"; content: string; timestamp: number }
  >;
  tools?: Array<{
    name: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
  }>;
  replayResponsesItemIds?: boolean;
}) {
  // Abort after payload capture so tests inspect serialization without network I/O.
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;

  const responseStream = stream(
    buildModel(),
    {
      systemPrompt: "system",
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      replayResponsesItemIds: params.replayResponsesItemIds ?? true,
      signal: controller.signal,
      onPayload: (nextPayload: unknown) => {
        payload = nextPayload as Record<string, unknown>;
      },
    } as never,
  );

  await responseStream.result();
  const input = extractInput(payload);
  return {
    input,
    types: extractInputTypes(input),
  };
}

describe("openai-responses reasoning replay", () => {
  it("replays reasoning for tool-call-only turns (OpenAI requires it)", async () => {
    const assistantToolOnly = buildAssistantMessage({
      stopReason: "toolUse",
      content: [
        buildReasoningPart(),
        {
          type: "toolCall",
          id: "call_123|fc_123",
          name: "noop",
          arguments: {},
        },
      ],
    });

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    };

    const { input, types } = await runAbortedOpenAIResponsesStream({
      messages: [
        {
          role: "user",
          content: "Call noop.",
          timestamp: Date.now(),
        },
        assistantToolOnly,
        toolResult,
        {
          role: "user",
          content: "Now reply with ok.",
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "noop",
          description: "no-op",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("function_call");
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));

    const functionCall = input.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "function_call",
    ) as Record<string, unknown> | undefined;
    expect(functionCall?.call_id).toBe("call_123");
    expect(functionCall?.id).toBe("fc_123");
  });

  it("still replays reasoning when paired with an assistant message", async () => {
    const assistantWithText = buildAssistantMessage({
      stopReason: "stop",
      content: [buildReasoningPart(), { type: "text", text: "hello", textSignature: "msg_test" }],
    });

    const { types } = await runAbortedOpenAIResponsesStream({
      messages: [
        { role: "user", content: "Hi", timestamp: Date.now() },
        assistantWithText,
        { role: "user", content: "Ok", timestamp: Date.now() },
      ],
    });

    expect(types).toContain("reasoning");
    expect(types).toContain("message");
  });

  it("assigns distinct ids to multiple id-less text blocks after a reasoning drop", async () => {
    // After a model/fallback switch the sanitizer strips textSignatures from a
    // turn's text blocks. msgIndex is per-message, so the transport must still
    // emit unique message-item ids per text block (issue #88019).
    const assistantWithTwoTexts = buildAssistantMessage({
      stopReason: "stop",
      content: [
        { type: "text", text: "commentary" },
        { type: "text", text: "final" },
      ],
    });

    const { input } = await runAbortedOpenAIResponsesStream({
      messages: [
        { role: "user", content: "Hi", timestamp: Date.now() },
        assistantWithTwoTexts,
        { role: "user", content: "Ok", timestamp: Date.now() },
      ],
    });

    const messageIds = extractInputMessages(input).map((item) => item.id);
    expect(messageIds).toHaveLength(2);
    expect(messageIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(messageIds).size).toBe(2);
  });

  it("does not replay a signed assistant message id after its reasoning item was pruned", async () => {
    // Signed message ids are only safe to replay when their preceding reasoning item survived.
    expect(
      resolveReplayableResponsesMessageId({
        replayResponsesItemIds: true,
        textSignatureId: "msg_real_response_item_requiring_reasoning",
        fallbackId: "msg_0",
        fallbackOrdinal: 0,
        previousReplayItemWasReasoning: false,
      }),
    ).toBeUndefined();

    expect(
      resolveReplayableResponsesMessageId({
        replayResponsesItemIds: true,
        textSignatureId: "msg_real_response_item_requiring_reasoning",
        fallbackId: "msg_0",
        fallbackOrdinal: 0,
        previousReplayItemWasReasoning: true,
      }),
    ).toBe("msg_real_response_item_requiring_reasoning");

    expect(
      resolveReplayableResponsesMessageId({
        replayResponsesItemIds: true,
        textSignatureId: "msg_commentary",
        fallbackId: "msg_0",
        fallbackOrdinal: 0,
        previousReplayItemWasReasoning: false,
      }),
    ).toBeUndefined();

    expect(
      resolveReplayableResponsesMessageId({
        replayResponsesItemIds: true,
        fallbackId: "msg_0",
        fallbackOrdinal: 0,
        previousReplayItemWasReasoning: false,
      }),
    ).toBe("msg_0");

    expect(
      resolveReplayableResponsesMessageId({
        replayResponsesItemIds: true,
        fallbackId: "msg_0",
        fallbackOrdinal: 1,
        previousReplayItemWasReasoning: false,
      }),
    ).toBe("msg_0_1");
  });

  it.each(["commentary", "final_answer"] as const)(
    "replays assistant message id and phase metadata for %s when paired with reasoning",
    async (phase) => {
      const assistantWithText = buildAssistantMessage({
        stopReason: "stop",
        content: [
          buildReasoningPart(),
          {
            type: "text",
            text: "hello",
            textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }),
          },
        ],
      });

      const { input, types } = await runAbortedOpenAIResponsesStream({
        messages: [
          { role: "user", content: "Hi", timestamp: Date.now() },
          assistantWithText,
          { role: "user", content: "Ok", timestamp: Date.now() },
        ],
      });

      expect(types).toContain("message");

      const replayedMessage = extractInputMessages(input).find(
        (item) => item.id === `msg_${phase}`,
      );
      expect(replayedMessage?.phase).toBe(phase);
    },
  );

  it.each(["commentary", "final_answer"] as const)(
    "omits phase-tagged assistant message id for %s when reasoning is absent",
    async (phase) => {
      const assistantWithText = buildAssistantMessage({
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "hello",
            textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }),
          },
        ],
      });

      const { input } = await runAbortedOpenAIResponsesStream({
        messages: [
          { role: "user", content: "Hi", timestamp: Date.now() },
          assistantWithText,
          { role: "user", content: "Ok", timestamp: Date.now() },
        ],
      });

      const [replayedMessage] = extractInputMessages(input);
      expect(replayedMessage).toMatchObject({ phase });
      expect(replayedMessage).not.toHaveProperty("id");
    },
  );

  it("replays a synthetic id while preserving phase for id-less text signatures", async () => {
    // After a reasoning drop the sanitizer keeps the phase but removes the msg_*
    // id. The conversion must then emit a unique synthetic id per text block AND
    // retain the phase metadata (issue #88019 review follow-up).
    const assistantWithPhaseOnly = buildAssistantMessage({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: "commentary",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
        },
        {
          type: "text",
          text: "final",
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
        },
      ],
    });

    const { input } = await runAbortedOpenAIResponsesStream({
      messages: [
        { role: "user", content: "Hi", timestamp: Date.now() },
        assistantWithPhaseOnly,
        { role: "user", content: "Ok", timestamp: Date.now() },
      ],
    });

    const messages = extractInputMessages(input);
    expect(messages).toHaveLength(2);
    const ids = messages.map((item) => item.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(messages.map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
  });
});
