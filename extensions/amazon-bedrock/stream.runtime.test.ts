// Amazon Bedrock tests cover stream plugin behavior.
import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
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

async function captureCommandInput(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
): Promise<Record<string, unknown>> {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);
  await streamBedrockForTest(model, context, options).result();
  const command = send.mock.calls.at(-1)?.[0] as { input?: Record<string, unknown> } | undefined;
  if (!command?.input) {
    throw new Error("expected ConverseStreamCommand input");
  }
  return command.input;
}

async function captureClientRegion(
  model: Parameters<typeof streamSimpleBedrock>[0],
  options: BedrockOptions = {},
): Promise<string> {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);

  await streamBedrockForTest(
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

describe("Bedrock stream client lifecycle", () => {
  const context = {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  } as never;

  function expectDestroyedClient(
    send: ReturnType<typeof vi.spyOn>,
    destroy: ReturnType<typeof vi.spyOn>,
  ) {
    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.contexts[0]).toBe(send.mock.contexts[0]);
    expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      send.mock.invocationCallOrder[0] ?? 0,
    );
  }

  it("destroys the client after a successful stream", async () => {
    let markStreamBlocked!: () => void;
    const streamBlocked = new Promise<void>((resolve) => {
      markStreamBlocked = resolve;
    });
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* successfulStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      markStreamBlocked();
      await streamReleased;
      yield { messageStop: { stopReason: BedrockStopReason.END_TURN } };
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "bedrock-request-1" },
      stream: successfulStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const onProviderAccepted = vi.fn();
    const onResponse = vi.fn();

    const resultPromise = streamBedrockForTest(bedrockModel({}), context, {
      onProviderAccepted,
      onResponse,
    }).result();
    await streamBlocked;
    expect(destroy).not.toHaveBeenCalled();

    releaseStream();
    const result = await resultPromise;

    expect(result.stopReason).toBe("stop");
    expect(onProviderAccepted).toHaveBeenCalledWith(
      {
        kind: "http_response",
        status: 200,
        headers: { "x-amzn-requestid": "bedrock-request-1" },
      },
      expect.objectContaining({ provider: "amazon-bedrock" }),
    );
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-amzn-requestid": "bedrock-request-1" } },
      expect.objectContaining({ provider: "amazon-bedrock" }),
    );
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client after a provider error", async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockRejectedValue(new Error("synthetic provider failure"));
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest(bedrockModel({}), context).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("synthetic provider failure");
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client when response stream iteration fails", async () => {
    async function* failingStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      throw new Error("synthetic iterator failure");
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: failingStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest(bedrockModel({}), context).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("synthetic iterator failure");
    expectDestroyedClient(send, destroy);
  });

  it("destroys the client after an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockRejectedValue(new Error("synthetic abort"));
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamBedrockForTest(bedrockModel({}), context, {
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("synthetic abort");
    expectDestroyedClient(send, destroy);
  });
});

describe("Bedrock inbound image base64", () => {
  const model = () => bedrockModel({ input: ["text", "image"] });
  const userImage = (data: string) =>
    ({
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data }] }],
    }) as never;

  it("rejects malformed base64 and decodes a valid PNG without Node Buffer", async () => {
    const malformed = await streamBedrockForTest(model(), userImage("!!!not-base64!!!")).result();
    expect(malformed.errorMessage).toMatch(/Amazon Bedrock image content has malformed base64/);

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const nodeBuffer = globalThis.Buffer;
    let input: Record<string, unknown>;
    try {
      Reflect.deleteProperty(globalThis, "Buffer");
      input = await captureCommandInput(model(), userImage(png));
    } finally {
      Reflect.set(globalThis, "Buffer", nodeBuffer);
    }
    const messages = input.messages as Array<{ content?: unknown }>;
    const content = messages[0]?.content as Array<{
      image?: { source?: { bytes?: Uint8Array } };
    }>;
    expect(content[0]?.image?.source?.bytes?.byteLength).toBeGreaterThan(0);
  });
});

describe("Bedrock tool-result replay", () => {
  it("replays unsupported audio attachments as their canonical text placeholder", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_audio",
          toolName: "listen",
          content: [{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" }],
          isError: false,
        },
      ],
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_audio",
            content: [{ text: "(see attached audio)" }],
          },
        },
      ],
    });
  });

  it("preserves valid text and image attachments alongside unsupported audio", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_media",
          toolName: "inspect",
          content: [
            { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
            { type: "text", text: "actual tool output" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          isError: false,
        },
      ],
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_media",
            content: [
              { text: "actual tool output" },
              { image: { format: "png", source: { bytes: expect.any(Uint8Array) } } },
            ],
          },
        },
      ],
    });
  });

  it("drops payload-less image husks from consecutive tool results", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
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
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

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

describe("Bedrock profile endpoint resolution", () => {
  it("lets configured profiles own standard endpoint resolution", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    await streamBedrockForTest(
      bedrockModel({ baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" }),
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
      { profile: "prod-bedrock", region: "us-west-2" },
    ).result();

    const client = send.mock.contexts.at(-1) as BedrockRuntimeClient;
    expect(client.config.endpoint).toBeUndefined();
    await expect(client.config.region()).resolves.toBe("us-west-2");
  });

  it.each([
    {
      name: "plain model id",
      modelId: "amazon.nova-micro-v1:0",
      ambientRegion: "eu-west-1",
      expectedRegion: "eu-west-1",
    },
    {
      name: "blank primary region with a fallback env",
      modelId: "amazon.nova-micro-v1:0",
      ambientRegion: "   ",
      fallbackRegion: "eu-west-1",
      expectedRegion: "eu-west-1",
    },
    {
      name: "blank region env vars",
      modelId: "amazon.nova-micro-v1:0",
      ambientRegion: " ",
      fallbackRegion: "\t",
      expectedRegion: "us-east-1",
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
    async ({ modelId, ambientRegion, fallbackRegion, explicitRegion, expectedRegion }) => {
      vi.stubEnv("AWS_PROFILE", "");
      vi.stubEnv("AWS_REGION", ambientRegion);
      if (fallbackRegion !== undefined) {
        vi.stubEnv("AWS_DEFAULT_REGION", fallbackRegion);
      }

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
    {
      name: "text",
      events: [
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "truncated response" } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
      ],
      contentType: "text",
    },
    {
      name: "tool call",
      events: [
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_lookup", name: "lookup" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"query":"partial"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
      ],
      contentType: "toolCall",
    },
  ])(
    "reports truncated $name streams without a terminal messageStop",
    async ({ events, contentType }) => {
      vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
        stream: streamEvents([{ messageStart: { role: ConversationRole.ASSISTANT } }, ...events]),
      } as never);

      const stream = streamBedrockForTest(bedrockModel({}), {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      } as never);
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

      expect(eventTypes.at(-1)).toBe("error");
      expect(eventTypes).not.toContain("done");
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Bedrock stream ended before messageStop");
      expect(result.content).toEqual([expect.objectContaining({ type: contentType })]);
      expect(result.content[0]).not.toHaveProperty("index");
      expect(result.content[0]).not.toHaveProperty("partialJson");
    },
  );

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

    const result = await streamBedrockForTest(bedrockModel({}), {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    } as never).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(stopReason);
  });
});

describe("Bedrock thinking request composition", () => {
  const context = {
    messages: [{ role: "user", content: "Think carefully.", timestamp: 0 }],
  } as never;

  it.each([
    {
      name: "Opus 5 default",
      model: () =>
        bedrockModel({
          id: "global.anthropic.claude-opus-5",
          name: "Claude Opus 5",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      reasoning: undefined,
      expectedMaxTokens: 128_000,
      expectedEffort: "high",
    },
    {
      name: "Opus 5 explicit off",
      model: () =>
        bedrockModel({
          id: "global.anthropic.claude-opus-5",
          name: "Claude Opus 5",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      reasoning: "off" as const,
      expectedMaxTokens: undefined,
      expectedEffort: undefined,
    },
    {
      name: "Sonnet 5 default",
      model: () =>
        bedrockModel({
          id: "us.anthropic.claude-sonnet-5",
          name: "Claude Sonnet 5",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
        }),
      reasoning: undefined,
      expectedMaxTokens: 128_000,
      expectedEffort: "high",
    },
    {
      name: "Sonnet 5 explicit off",
      model: () =>
        bedrockModel({
          id: "us.anthropic.claude-sonnet-5",
          name: "Claude Sonnet 5",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
        }),
      reasoning: "off" as const,
      expectedMaxTokens: 128_000,
      expectedEffort: "low",
    },
  ])("sends $name policy in the final request", async (testCase) => {
    const options = testCase.reasoning === undefined ? {} : { reasoning: testCase.reasoning };
    const input = await captureCommandInput(testCase.model(), context, options);

    expect(input.inferenceConfig).toEqual(
      testCase.expectedMaxTokens === undefined ? {} : { maxTokens: testCase.expectedMaxTokens },
    );
    expect(input.additionalModelRequestFields).toEqual(
      testCase.expectedEffort === undefined
        ? undefined
        : {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: testCase.expectedEffort },
          },
    );
  });

  it("does not force thinking when an optional Claude model omits reasoning", async () => {
    const input = await captureCommandInput(
      bedrockModel({ id: "anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
      context,
    );

    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it.each([
    { reasoning: "minimal" as const, maxTokens: 1024 },
    { reasoning: "low" as const, maxTokens: 1500 },
  ])("disables legacy $reasoning thinking beyond a $maxTokens cap", async (testCase) => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "anthropic.claude-haiku-4-5-v1:0",
        name: "Claude Haiku 4.5",
        maxTokens: testCase.maxTokens,
      }),
      context,
      { reasoning: testCase.reasoning },
    );

    expect(input.inferenceConfig).toEqual({ maxTokens: testCase.maxTokens });
    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it.each([
    {
      name: "native model cap",
      modelMaxTokens: 128_000,
      requestedMaxTokens: undefined,
      expected: 128_000,
    },
    {
      name: "fallback model cap",
      modelMaxTokens: 4096,
      requestedMaxTokens: undefined,
      expected: undefined,
    },
    {
      name: "explicit request cap",
      modelMaxTokens: 128_000,
      requestedMaxTokens: 32_000,
      expected: 32_000,
    },
  ])("uses the $name for adaptive thinking", async (testCase) => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "us.anthropic.claude-opus-4-8",
        name: "Claude Opus 4.8",
        contextWindow: 1_000_000,
        maxTokens: testCase.modelMaxTokens,
      }),
      context,
      {
        reasoning: "high",
        ...(testCase.requestedMaxTokens === undefined
          ? {}
          : { maxTokens: testCase.requestedMaxTokens }),
      },
    );

    expect(input.inferenceConfig).toEqual(
      testCase.expected === undefined ? {} : { maxTokens: testCase.expected },
    );
    expect(input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it.each([
    { reasoning: undefined, expectedEffort: "high" },
    { reasoning: "off" as const, expectedEffort: "low" },
  ])("sends Mythos 5 effort $expectedEffort for reasoning=$reasoning", async (testCase) => {
    const options = testCase.reasoning === undefined ? {} : { reasoning: testCase.reasoning };
    const input = await captureCommandInput(
      bedrockModel({
        id: "us.anthropic.claude-mythos-5",
        name: "Claude Mythos 5",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      context,
      options,
    );

    expect(input.inferenceConfig).toEqual({ maxTokens: 128_000 });
    expect(input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: testCase.expectedEffort },
    });
  });

  it("uses descriptive Claude names for opaque profile effort", async () => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc",
        name: "Claude Production Opus 4.8",
      }),
      context,
      { reasoning: "xhigh" },
    );

    expect(input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
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

  it("sends always-adaptive high effort without unsupported request controls", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: "end_turn" } },
      ]),
    } as never);

    const stream = streamBedrockForTest(fableModel(), context(), {
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

    const stream = streamBedrockForTest(fableModel(), context(), {
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
