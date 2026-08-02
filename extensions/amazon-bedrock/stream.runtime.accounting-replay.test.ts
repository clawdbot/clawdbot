// Bedrock provider-owner regressions cover reasoning replay, prompt caches, and token accounting.
import {
  BedrockRuntimeClient,
  CacheTTL,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import { streamSimpleBedrock } from "./stream.runtime.js";
import { streamTesting as testing } from "./test-support.js";

function bedrockModel(overrides: Record<string, unknown>) {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as never;
}

function signedThinkingContext(modelId: string) {
  const highSurrogate = String.fromCharCode(0xd83d);
  return {
    messages: [
      {
        role: "assistant",
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: modelId,
        content: [
          {
            type: "thinking",
            thinking: `private${highSurrogate}reasoning`,
            thinkingSignature: "sig-1",
          },
        ],
      },
    ],
  } as never;
}

async function* streamEvents(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

function streamBedrockForTest(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
) {
  return streamSimpleBedrock(model, context, options as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bedrock reasoning replay", () => {
  it("preserves streamed redacted reasoning and replays its opaque bytes unchanged", async () => {
    const modelId = "anthropic.claude-haiku-4-5-20251001-v1:0";
    const opaqueReasoning = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const model = bedrockModel({ id: modelId, name: "Claude Haiku 4.5" });
    const encodeOpaqueReasoning = vi.spyOn(globalThis, "btoa");
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: opaqueReasoning.slice(0, 2) } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: opaqueReasoning.slice(2) } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    const result = await streamBedrockForTest(model, {
      messages: [{ role: "user", content: "Think privately", timestamp: 0 }],
    } as never).result();

    expect(result.content).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "3q2+7w==",
        redacted: true,
      },
    ]);
    expect(encodeOpaqueReasoning).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);
    await streamBedrockForTest(model, {
      messages: [result, { role: "user", content: "Continue", timestamp: 1 }],
    } as never).result();

    const replayCommand = send.mock.calls[1]?.[0] as {
      input?: { messages?: Array<{ content?: unknown[] }> };
    };
    expect(replayCommand.input?.messages?.[0]?.content).toEqual([
      { reasoningContent: { redactedContent: opaqueReasoning } },
    ]);
  });

  it("preserves signed reasoning for Claude profile descriptors", () => {
    const modelId =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc";
    const messages = testing.convertMessages(
      signedThinkingContext(modelId),
      bedrockModel({
        id: modelId,
        name: "Claude Sonnet application profile",
      }),
      "none",
    );

    expect(messages[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: {
            text: `private${String.fromCharCode(0xd83d)}reasoning`,
            signature: "sig-1",
          },
        },
      },
    ]);
  });

  it("replays signed reasoning as plain text for non-Claude models", () => {
    const modelId = "amazon.nova-micro-v1:0";
    const messages = testing.convertMessages(
      signedThinkingContext(modelId),
      bedrockModel({ id: modelId, name: "Nova Micro" }),
      "none",
    );

    expect(messages[0]?.content).toEqual([{ text: "privatereasoning" }]);
  });

  it.each(["3q2+7w==", undefined])(
    "drops opaque Claude reasoning when switching to an unsupported model (signature: %s)",
    (thinkingSignature) => {
      const modelId = "amazon.nova-micro-v1:0";
      const messages = testing.convertMessages(
        {
          messages: [
            {
              role: "assistant",
              api: "bedrock-converse-stream",
              provider: "amazon-bedrock",
              model: "anthropic.claude-haiku-4-5-20251001-v1:0",
              content: [
                {
                  type: "thinking",
                  thinking: "[Reasoning redacted]",
                  thinkingSignature,
                  redacted: true,
                },
                { type: "text", text: "Safe visible response" },
              ],
            },
          ],
        } as never,
        bedrockModel({ id: modelId, name: "Nova Micro" }),
        "none",
      );

      expect(messages[0]?.content).toEqual([{ text: "Safe visible response" }]);
    },
  );

  it.each(["3q2+7w==", undefined])(
    "drops model-bound opaque reasoning when switching between Claude models (signature: %s)",
    (thinkingSignature) => {
      const targetModelId = "anthropic.claude-sonnet-4-5-20250929-v1:0";
      const messages = testing.convertMessages(
        {
          messages: [
            {
              role: "assistant",
              api: "bedrock-converse-stream",
              provider: "amazon-bedrock",
              model: "anthropic.claude-haiku-4-5-20251001-v1:0",
              content: [
                {
                  type: "thinking",
                  thinking: "[Reasoning redacted]",
                  thinkingSignature,
                  redacted: true,
                },
                { type: "text", text: "Safe visible response" },
              ],
            },
          ],
        } as never,
        bedrockModel({ id: targetModelId, name: "Claude Sonnet 4.5" }),
        "none",
      );

      expect(messages[0]?.content).toEqual([{ text: "Safe visible response" }]);
    },
  );

  it("preserves signature-only Fable reasoning blocks", () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "assistant",
            api: "bedrock-converse-stream",
            provider: "amazon-bedrock",
            model: modelId,
            content: [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: " sig-fable ",
              },
            ],
          },
        ],
      } as never,
      bedrockModel({ id: modelId, name: "Claude Fable 5" }),
      "none",
    );

    expect(messages[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: {
            text: "",
            signature: " sig-fable ",
          },
        },
      },
    ]);
  });

  it("drops synthetic reasoning placeholders from Claude replay", () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "assistant",
            api: "bedrock-converse-stream",
            provider: "amazon-bedrock",
            model: modelId,
            content: [
              {
                type: "thinking",
                thinking: "hidden compatibility reasoning",
                thinkingSignature: "reasoning_content",
              },
            ],
          },
        ],
      } as never,
      bedrockModel({ id: modelId, name: "Claude Fable 5" }),
      "none",
    );

    expect(messages).toEqual([]);
  });
});

describe("Bedrock prompt cache ownership", () => {
  const model = () =>
    bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" });

  it("anchors prompt caching on the last stable user turn instead of transient runtime context", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          { role: "user", content: "stable operator request", timestamp: 0 },
          {
            role: "user",
            content: "volatile current-turn metadata",
            runtimeContextCarrier: true,
            timestamp: 1,
          },
        ],
      },
      model(),
      "short",
    );

    expect(messages).toEqual([
      {
        role: ConversationRole.USER,
        content: [{ text: "stable operator request" }, { cachePoint: { type: "default" } }],
      },
      { role: ConversationRole.USER, content: [{ text: "volatile current-turn metadata" }] },
    ]);
  });

  it("does not cache a runtime-context carrier when no stable user turn exists", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "user",
            content: "volatile current-turn metadata",
            runtimeContextCarrier: true,
            timestamp: 0,
          },
        ],
      },
      model(),
      "short",
    );

    expect(messages).toEqual([
      { role: ConversationRole.USER, content: [{ text: "volatile current-turn metadata" }] },
    ]);
  });

  it("never includes a runtime-context carrier in the cached prefix of a later user turn", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          { role: "user", content: "stable operator request", timestamp: 0 },
          {
            role: "user",
            content: "volatile current-turn metadata",
            runtimeContextCarrier: true,
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_follow_up",
            toolName: "read",
            content: [{ type: "text", text: "later stable tool output" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as never,
      model(),
      "long",
    );

    expect(messages[0]?.content).toEqual([
      { text: "stable operator request" },
      { cachePoint: { type: "default", ttl: "1h" } },
    ]);
    expect(messages[1]?.content).toEqual([{ text: "volatile current-turn metadata" }]);
    expect(messages[2]?.content).toEqual([
      {
        toolResult: {
          toolUseId: "call_follow_up",
          content: [{ text: "later stable tool output" }],
          status: "success",
        },
      },
    ]);
  });

  it("does not cache a later stable turn when volatile context starts the prefix", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "user",
            content: "volatile current-turn metadata",
            runtimeContextCarrier: true,
            timestamp: 0,
          },
          { role: "user", content: "later stable operator request", timestamp: 1 },
        ],
      },
      model(),
      "long",
    );

    expect(messages).toEqual([
      { role: ConversationRole.USER, content: [{ text: "volatile current-turn metadata" }] },
      { role: ConversationRole.USER, content: [{ text: "later stable operator request" }] },
    ]);
  });
});

describe("Bedrock token usage", () => {
  it("includes cached prompt tokens in authoritative total and context usage", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          metadata: {
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              cacheReadInputTokens: 70,
              cacheWriteInputTokens: 10,
            },
          },
        },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    const result = await streamBedrockForTest(bedrockModel({}), {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    } as never).result();

    expect(result.usage).toMatchObject({
      input: 20,
      output: 5,
      cacheRead: 70,
      cacheWrite: 10,
      totalTokens: 105,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 105 },
    });
  });

  it("prices one-hour cache writes from the provider's authoritative TTL breakdown", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          metadata: {
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              cacheReadInputTokens: 70,
              cacheWriteInputTokens: 10,
              cacheDetails: [
                { ttl: CacheTTL.ONE_HOUR, inputTokens: 6 },
                { ttl: CacheTTL.FIVE_MINUTES, inputTokens: 4 },
              ],
            },
          },
        },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    const result = await streamBedrockForTest(
      bedrockModel({
        cost: { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 1_250_000 },
      }),
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
    ).result();

    expect(result.usage.cacheWrite1h).toBe(6);
    expect(result.usage.cost).toMatchObject({
      input: 20,
      output: 10,
      cacheRead: 35,
      cacheWrite: 17,
      total: 82,
    });
  });
});
