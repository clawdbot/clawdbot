// Bedrock provider-owner regressions cover reasoning replay, prompt caches, and token accounting.
import {
  BedrockRuntimeClient,
  CacheTTL,
  ConversationRole,
  ConverseStreamCommand,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

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

async function capturePayload(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
) {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);
  await streamBedrockForTest(model, context, options).result();
  const command = send.mock.calls.at(-1)?.[0];
  if (!(command instanceof ConverseStreamCommand)) {
    throw new Error("expected ConverseStreamCommand");
  }
  return command.input;
}

async function captureMessages(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Context,
  options: BedrockOptions = {},
) {
  return (await capturePayload(model, context, options)).messages ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("preserves signed reasoning for Claude profile descriptors", async () => {
    const modelId =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc";
    const messages = await captureMessages(
      bedrockModel({
        id: modelId,
        name: "Claude Sonnet application profile",
      }),
      signedThinkingContext(modelId),
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

  it("replays signed reasoning as plain text for non-Claude models", async () => {
    const modelId = "amazon.nova-micro-v1:0";
    const messages = await captureMessages(
      bedrockModel({ id: modelId, name: "Nova Micro" }),
      signedThinkingContext(modelId),
    );

    expect(messages[0]?.content).toEqual([{ text: "privatereasoning" }]);
  });

  it.each(["3q2+7w==", undefined])(
    "drops opaque Claude reasoning when switching to an unsupported model (signature: %s)",
    async (thinkingSignature) => {
      const modelId = "amazon.nova-micro-v1:0";
      const messages = await captureMessages(bedrockModel({ id: modelId, name: "Nova Micro" }), {
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
      } as never);

      expect(messages[0]?.content).toEqual([{ text: "Safe visible response" }]);
    },
  );

  it.each(["3q2+7w==", undefined])(
    "drops model-bound opaque reasoning when switching between Claude models (signature: %s)",
    async (thinkingSignature) => {
      const targetModelId = "anthropic.claude-sonnet-4-5-20250929-v1:0";
      const messages = await captureMessages(
        bedrockModel({ id: targetModelId, name: "Claude Sonnet 4.5" }),
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
      );

      expect(messages[0]?.content).toEqual([{ text: "Safe visible response" }]);
    },
  );

  it("preserves signature-only Fable reasoning blocks", async () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = await captureMessages(bedrockModel({ id: modelId, name: "Claude Fable 5" }), {
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
    } as never);

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

  it("drops synthetic reasoning placeholders from Claude replay", async () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = await captureMessages(bedrockModel({ id: modelId, name: "Claude Fable 5" }), {
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
    } as never);

    expect(messages).toEqual([]);
  });
});

describe("Bedrock prompt cache ownership", () => {
  it("keeps unset Nova payloads identical to disabled caching despite environment defaults", async () => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
    vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", "1");
    const model = bedrockModel({});
    const context: Context = {
      systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: Monday`,
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    };
    const unset = await capturePayload(model, context);
    const disabled = await capturePayload(model, context, { cacheRetention: "none" });
    expect(JSON.stringify(unset)).not.toContain("cachePoint");
    expect(JSON.stringify(unset)).toBe(JSON.stringify(disabled));
  });

  it.each([
    ["amazon.nova-micro-v1:0", true],
    ["eu.amazon.nova-lite-v1:0", true],
    ["apac.amazon.nova-pro-v1:0", true],
    ["us.amazon.nova-premier-v1:0", true],
    ["global.amazon.nova-2-lite-v1:0", true],
    ["arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0", true],
    ["arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0", true],
    ["amazon.nova-sonic-v1:0", false],
    ["amazon.nova-lite-v2:0", false],
    ["amazon.nova-pro-v1:0:custom", false],
    ["meta.llama3-70b-instruct-v1:0", false],
    [
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/amazon.nova-pro-v1:0",
      false,
    ],
  ])("emits only supported Nova checkpoints for %s", async (id, supported) => {
    for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
      const payload = await capturePayload(
        bedrockModel({ id, name: "Nova Pro" }),
        {
          systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: Monday`,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        cacheRetention === undefined ? {} : { cacheRetention },
      );
      if (supported && (cacheRetention === "short" || cacheRetention === "long")) {
        expect(payload.system).toEqual([
          { text: "Stable workspace" },
          { cachePoint: { type: "default" } },
          { text: "Today: Monday" },
        ]);
        expect(payload.messages?.[0]?.content).toEqual([
          { text: "Hello" },
          { cachePoint: { type: "default" } },
        ]);
      } else {
        expect(JSON.stringify(payload)).not.toContain("cachePoint");
        if (supported || cacheRetention === "none") {
          expect(payload.system).toEqual([{ text: "Stable workspace\nToday: Monday" }]);
        }
      }
      expect(payload.toolConfig?.tools).toHaveLength(1);
      expect(payload.toolConfig?.tools?.[0]).toHaveProperty("toolSpec.name", "lookup");
      expect(JSON.stringify(payload.toolConfig)).not.toContain("cachePoint");
    }
  });

  it.each(["direct", "application-profile"])(
    "advances the retained-carrier checkpoint through a tool loop (%s)",
    async (route) => {
      const canonicalModelId = "claude-fable-5-1";
      const model: Model<"bedrock-converse-stream"> = bedrockModel({
        id:
          route === "direct"
            ? `anthropic.${canonicalModelId}-v1:0`
            : "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/cache-test",
        name: "Test deployment",
        ...(route === "application-profile" ? { params: { canonicalModelId } } : {}),
      });
      const context: Context = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "First request" },
              { type: "text", text: "Retained context one" },
            ],
            runtimeContextCarrier: true,
            timestamp: 0,
          },
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: "text", text: "First answer" }],
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: 1,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Second request" },
              { type: "text", text: "Retained context two" },
            ],
            runtimeContextCarrier: true,
            timestamp: 2,
          },
        ],
      };
      const first = await captureMessages(model, context, { cacheRetention: "short" });
      expect(first[2]?.content?.at(-1)).toEqual({ cachePoint: { type: "default" } });
      const previousAssistant = context.messages[1];
      if (previousAssistant?.role !== "assistant") {
        throw new Error("missing assistant fixture");
      }
      context.messages.push(
        {
          ...previousAssistant,
          content: [{ type: "toolCall", id: "read_1", name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "read_1",
          toolName: "read",
          content: [{ type: "text", text: "Tool output" }],
          isError: false,
          timestamp: 4,
        },
      );
      const second = await captureMessages(model, context, { cacheRetention: "short" });
      expect(second[2]?.content).toEqual([
        { text: "Second request" },
        { text: "Retained context two" },
      ]);
      expect(second[4]?.content?.at(-1)).toEqual({ cachePoint: { type: "default" } });
      expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    },
  );

  it.each(["short", "long", "none"] as const)(
    "keeps stable system bytes and checkpoint position across suffix changes (%s)",
    async (cacheRetention) => {
      const requests = [];
      for (const suffix of ["Today: Monday", "Today: Tuesday"]) {
        requests.push(
          await capturePayload(
            bedrockModel({
              id: "anthropic.claude-haiku-4-5-20251001-v1:0",
              name: "Claude Haiku 4.5",
            }),
            {
              systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}`,
              messages: [{ role: "user", content: "Hello", timestamp: 0 }],
            },
            { cacheRetention },
          ),
        );
      }
      for (const [index, payload] of requests.entries()) {
        const suffix = index === 0 ? "Today: Monday" : "Today: Tuesday";
        expect(JSON.stringify(payload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
        if (cacheRetention === "none") {
          expect(JSON.stringify(payload)).not.toContain("cachePoint");
          expect(payload.system).toEqual([{ text: `Stable workspace\n${suffix}` }]);
        } else {
          expect(payload.system).toEqual([
            { text: "Stable workspace" },
            {
              cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
            },
            { text: suffix },
          ]);
          expect(JSON.stringify(payload).match(/"cachePoint"/g)).toHaveLength(2);
        }
      }
      if (cacheRetention !== "none") {
        expect(requests[0]?.system?.slice(0, 2)).toEqual(requests[1]?.system?.slice(0, 2));
      }
    },
  );

  const model = () =>
    bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" });

  it("anchors prompt caching on the last stable user turn instead of transient runtime context", async () => {
    const messages = await captureMessages(
      model(),
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
      { cacheRetention: "short" },
    );

    expect(messages).toEqual([
      {
        role: ConversationRole.USER,
        content: [{ text: "stable operator request" }, { cachePoint: { type: "default" } }],
      },
      { role: ConversationRole.USER, content: [{ text: "volatile current-turn metadata" }] },
    ]);
  });

  it("does not cache a runtime-context carrier when no stable user turn exists", async () => {
    const messages = await captureMessages(
      model(),
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
      { cacheRetention: "short" },
    );

    expect(messages).toEqual([
      { role: ConversationRole.USER, content: [{ text: "volatile current-turn metadata" }] },
    ]);
  });

  it("never includes a runtime-context carrier in the cached prefix of a later user turn", async () => {
    const messages = await captureMessages(
      model(),
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
      { cacheRetention: "long" },
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

  it("does not cache a later stable turn when volatile context starts the prefix", async () => {
    const messages = await captureMessages(
      model(),
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
      { cacheRetention: "long" },
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
