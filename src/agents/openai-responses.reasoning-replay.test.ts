import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { streamOpenAIResponses } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

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
      !!item && typeof item === "object" && (item as Record<string, unknown>).type === "message",
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
}) {
  const controller = new AbortController();
  controller.abort();
  let payload: Record<string, unknown> | undefined;

  const stream = streamOpenAIResponses(
    buildModel(),
    {
      systemPrompt: "system",
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      signal: controller.signal,
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    },
  );

  await stream.result();
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

  it.each(["commentary", "final_answer"] as const)(
    "replays assistant message phase metadata for %s",
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
});
