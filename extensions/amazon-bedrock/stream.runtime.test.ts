// Amazon Bedrock tests cover stream plugin behavior.
import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamBedrock, streamSimpleBedrock } from "./stream.runtime.js";
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

async function captureClientRegion(
  model: Parameters<typeof streamBedrock>[0],
  options: Parameters<typeof streamBedrock>[2] = {},
): Promise<string> {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);

  await streamBedrock(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
    options,
  ).result();

  const client = send.mock.contexts[0] as BedrockRuntimeClient;
  return client.config.region();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Bedrock tool-result replay", () => {
  it("drops payload-less image husks from consecutive tool results", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_husk",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
            isError: false,
          },
          {
            role: "toolResult",
            toolCallId: "call_text",
            toolName: "read",
            content: [{ type: "text", text: "actual tool output" }],
            isError: false,
          },
        ],
      } as never,
      bedrockModel({ input: ["text", "image"] }),
      "none",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { toolResult: { toolUseId: "call_husk", content: [{ text: "(no output)" }] } },
        { toolResult: { toolUseId: "call_text", content: [{ text: "actual tool output" }] } },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain('"image"');
    expect(JSON.stringify(messages)).not.toContain("see attached image");
  });
});

describe("Bedrock reasoning replay", () => {
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

describe("Bedrock profile endpoint resolution", () => {
  it("treats request profiles as configured profiles for standard endpoints", () => {
    const endpoint = "https://bedrock-runtime.us-west-2.amazonaws.com";

    expect(testing.hasConfiguredBedrockProfile({ profile: "prod-bedrock" })).toBe(true);
    expect(
      testing.shouldUseExplicitBedrockEndpoint(
        endpoint,
        undefined,
        testing.hasConfiguredBedrockProfile({ profile: "prod-bedrock" }),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "plain model id",
      modelId: "amazon.nova-micro-v1:0",
      ambientRegion: "eu-west-1",
      expectedRegion: "eu-west-1",
    },
    {
      name: "application inference-profile ARN",
      modelId: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/profile-abc",
      ambientRegion: "us-east-1",
      expectedRegion: "us-west-2",
    },
    {
      name: "GovCloud inference-profile ARN",
      modelId:
        "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/profile-abc",
      ambientRegion: "us-east-1",
      expectedRegion: "us-gov-west-1",
    },
    {
      name: "ARN with explicit region option",
      modelId: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/profile-abc",
      ambientRegion: "us-east-1",
      explicitRegion: "ap-southeast-2",
      expectedRegion: "ap-southeast-2",
    },
  ])(
    "resolves $name to $expectedRegion",
    async ({ modelId, ambientRegion, explicitRegion, expectedRegion }) => {
      vi.stubEnv("AWS_REGION", ambientRegion);

      await expect(
        captureClientRegion(
          bedrockModel({ id: modelId }),
          explicitRegion ? { region: explicitRegion } : {},
        ),
      ).resolves.toBe(expectedRegion);
    },
  );
});

describe("Bedrock stop reasons", () => {
  it.each([
    BedrockStopReason.CONTENT_FILTERED,
    BedrockStopReason.GUARDRAIL_INTERVENED,
    BedrockStopReason.MALFORMED_MODEL_OUTPUT,
    BedrockStopReason.MALFORMED_TOOL_USE,
  ])("reports the provider stop reason %s", async (stopReason) => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason } },
      ]),
    } as never);

    const result = await streamBedrock(bedrockModel({}), {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    } as never).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(stopReason);
  });
});

describe("Bedrock thinking effort mapping", () => {
  it.each([
    { reasoning: undefined, expected: "high" },
    { reasoning: "off" as const, expected: "low" },
  ])("keeps Sonnet 5 adaptive for reasoning=$reasoning", ({ reasoning, expected }) => {
    const model = bedrockModel({
      id: "us.anthropic.claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    });
    const options = testing.resolveSimpleBedrockOptions(model, { reasoning });

    expect(options).toMatchObject({ maxTokens: 128_000, reasoning: expected });
    expect(testing.buildAdditionalModelRequestFields(model, options)).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: expected },
    });
    expect(testing.buildAdditionalModelRequestFields(model, { reasoning })).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: expected },
    });
  });

  it("does not force adaptive thinking for optional Claude models when callers omit reasoning", () => {
    const model = bedrockModel({
      id: "anthropic.claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      reasoning: true,
    });
    const options = testing.resolveSimpleBedrockOptions(model, {});

    expect(options.reasoning).toBeUndefined();
    expect(testing.buildAdditionalModelRequestFields(model, options)).toBeUndefined();
  });

  it.each([
    { reasoning: "minimal" as const, maxTokens: 1024 },
    { reasoning: "low" as const, maxTokens: 1500 },
  ])(
    "disables legacy thinking when $reasoning exceeds the $maxTokens token cap",
    ({ reasoning, maxTokens }) => {
      const model = bedrockModel({
        id: "anthropic.claude-haiku-4-5-v1:0",
        name: "Claude Haiku 4.5",
        maxTokens,
      });
      const options = testing.resolveSimpleBedrockOptions(model, { reasoning });

      expect(options).toMatchObject({ maxTokens, reasoning: "off" });
      expect(testing.buildAdditionalModelRequestFields(model, options)).toBeUndefined();
    },
  );

  it("uses the model maxTokens cap for adaptive Claude thinking requests", () => {
    const model = bedrockModel({
      id: "us.anthropic.claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const options = testing.resolveSimpleBedrockOptions(model, { reasoning: "high" });

    expect(options.maxTokens).toBe(128_000);
    expect(options.reasoning).toBe("high");
    expect(testing.buildAdditionalModelRequestFields(model, options)).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it.each([4096, 8192, 16_384])(
    "does not turn fallback maxTokens %s into an adaptive cap",
    (maxTokens) => {
      const model = bedrockModel({
        id: "us.anthropic.claude-opus-4-8",
        name: "Claude Opus 4.8",
        reasoning: true,
        maxTokens,
      });
      const options = testing.resolveSimpleBedrockOptions(model, { reasoning: "high" });

      expect(options.maxTokens).toBeUndefined();
      expect(options.reasoning).toBe("high");
    },
  );

  it("preserves explicit maxTokens caps for adaptive Claude thinking requests", () => {
    const model = bedrockModel({
      id: "us.anthropic.claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const options = testing.resolveSimpleBedrockOptions(model, {
      reasoning: "high",
      maxTokens: 32_000,
    });

    expect(options.maxTokens).toBe(32_000);
  });

  it.each(["claude-mythos-preview", "claude-mythos-5"])(
    "forces adaptive thinking for Bedrock %s when callers omit reasoning",
    (modelId) => {
      const model = bedrockModel({
        id: `us.anthropic.${modelId}`,
        name: modelId,
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
      const options = testing.resolveSimpleBedrockOptions(model, {});

      expect(options.reasoning).toBe("high");
      expect(options.maxTokens).toBe(128_000);
      expect(testing.buildAdditionalModelRequestFields(model, options)).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      });
    },
  );

  it.each(["claude-mythos-preview", "claude-mythos-5"])(
    "maps explicit off to low effort for Bedrock %s",
    (modelId) => {
      const model = bedrockModel({
        id: `us.anthropic.${modelId}`,
        name: modelId,
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
      const options = testing.resolveSimpleBedrockOptions(model, { reasoning: "off" });

      expect(options.reasoning).toBe("low");
      expect(options.maxTokens).toBe(128_000);
      expect(testing.buildAdditionalModelRequestFields(model, options)).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "low" },
      });
    },
  );

  it("clamps max effort for Claude models without native max support", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
        }),
        "max",
      ),
    ).toBe("high");
  });

  it("caps unsupported xhigh effort at high for Claude Opus 4.6", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-opus-4-6-v1",
          name: "Claude Opus 4.6",
        }),
        "xhigh",
      ),
    ).toBe("high");
  });

  it("preserves max effort for Claude Opus 4.8", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-opus-4.8-v1:0",
          name: "Claude Opus 4.8",
        }),
        "max",
      ),
    ).toBe("max");
  });

  it("preserves max effort for Claude Mythos 5", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "anthropic.claude-mythos-5",
          name: "Claude Mythos 5",
        }),
        "max",
      ),
    ).toBe("max");
  });

  it("uses canonical Claude policy for deployment aliases", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "production-claude",
          name: "Production Claude",
          params: { canonicalModelId: "claude-opus-4-8" },
        }),
        "max",
      ),
    ).toBe("max");
  });

  it("preserves adaptive effort for opaque profiles with descriptive Claude names", () => {
    expect(
      testing.mapThinkingLevelToEffort(
        bedrockModel({
          id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc",
          name: "Claude Production Opus 4.8",
        }),
        "xhigh",
      ),
    ).toBe("xhigh");
  });
});

describe("Bedrock Fable contract", () => {
  function fableModel() {
    return bedrockModel({
      id: "production-fable",
      name: "Production deployment",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  }

  function context() {
    return {
      messages: [{ role: "user", content: "Reply briefly.", timestamp: 0 }],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as never;
  }

  it("uses the model maxTokens cap for simple Fable options", () => {
    const options = testing.resolveSimpleBedrockOptions(fableModel(), {});

    expect(options).toMatchObject({
      maxTokens: 128_000,
      reasoning: "high",
    });
  });

  it("sends always-adaptive high effort without unsupported request controls", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: "end_turn" } },
      ]),
    } as never);

    const stream = streamBedrock(fableModel(), context(), {
      reasoning: "high",
      temperature: 0.2,
      toolChoice: "any",
    });
    await stream.result();

    const command = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(command.input).toMatchObject({
      modelId: "production-fable",
      inferenceConfig: {},
      messages: [
        {
          role: "user",
          content: [{ text: "Reply briefly." }, { cachePoint: { type: "default" } }],
        },
      ],
      toolConfig: { toolChoice: { auto: {} } },
      additionalModelRequestFields: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
      additionalModelResponseFieldPaths: ["/stop_details"],
    });
  });

  it("preserves explicit tool disabling", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: "end_turn" } },
      ]),
    } as never);

    const stream = streamBedrock(fableModel(), context(), {
      reasoning: "high",
      toolChoice: "none",
    });
    await stream.result();

    const command = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(command.input?.toolConfig).toBeUndefined();
  });

  it.each([
    ["Fable", () => fableModel()],
    [
      "Mythos 5",
      () =>
        bedrockModel({
          id: "production-mythos",
          name: "Production deployment",
          params: { canonicalModelId: "claude-mythos-5" },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
    ],
  ])("quarantines partial output when %s returns a terminal refusal", async (_name, model) => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "discard this partial output" },
          },
        },
        {
          messageStop: {
            stopReason: "refusal",
            additionalModelResponseFields: {
              stop_details: {
                category: "cyber",
                explanation: "This request is not allowed.",
              },
            },
          },
        },
      ]),
    } as never);

    const stream = streamSimpleBedrock(model(), context());
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe(
      "Anthropic refusal (category: cyber): This request is not allowed.",
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: {
          provider: "amazon-bedrock",
          category: "cyber",
          explanation: "This request is not allowed.",
        },
      }),
    ]);
  });

  it("discards partial output when the Fable stream ends without messageStop", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "unsafe partial output" },
          },
        },
      ]),
    } as never);

    const stream = streamSimpleBedrock(fableModel(), context());
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toContain("ended before messageStop");
  });

  it("reports activity while Fable events are buffered", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "buffered output" },
          },
        },
        { messageStop: { stopReason: "end_turn" } },
      ]),
    } as never);
    const controller = new AbortController();
    let activityCount = 0;
    const unsubscribe = onLlmRequestActivity(controller.signal, () => {
      activityCount += 1;
    });

    try {
      const stream = streamSimpleBedrock(fableModel(), context(), {
        signal: controller.signal,
      });
      await stream.result();
    } finally {
      unsubscribe();
    }

    expect(activityCount).toBeGreaterThan(0);
  });
});

describe("Bedrock canonical Claude aliases", () => {
  it.each([
    {
      canonicalModelId: "claude-opus-4-8",
      reasoning: "xhigh" as const,
      thinkingLevelMap: { xhigh: "xhigh" as const, max: "max" as const },
      expectedEffort: "xhigh",
    },
    {
      canonicalModelId: "claude-opus-4-6",
      reasoning: "max" as const,
      thinkingLevelMap: { xhigh: null, max: "max" as const },
      expectedEffort: "max",
    },
    {
      canonicalModelId: "claude-opus-4-6",
      reasoning: "max" as const,
      thinkingLevelMap: { xhigh: null, max: null },
      expectedEffort: "high",
    },
  ])(
    "uses adaptive thinking and omits temperature for $canonicalModelId aliases",
    async ({ canonicalModelId, reasoning, thinkingLevelMap, expectedEffort }) => {
      const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
        stream: streamEvents([
          { messageStart: { role: ConversationRole.ASSISTANT } },
          { messageStop: { stopReason: "end_turn" } },
        ]),
      } as never);
      const model = bedrockModel({
        id: "production-claude",
        name: "Production Claude",
        reasoning: false,
        params: { canonicalModelId },
        thinkingLevelMap,
      });

      await streamSimpleBedrock(
        model,
        { messages: [{ role: "user", content: "Reply briefly.", timestamp: 0 }] } as never,
        {
          reasoning,
          temperature: 0.2,
        },
      ).result();

      const command = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
      expect(command.input).toMatchObject({
        modelId: "production-claude",
        inferenceConfig: {},
        additionalModelRequestFields: {
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: expectedEffort },
        },
      });
    },
  );
});
