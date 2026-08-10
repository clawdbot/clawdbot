import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { Api, Model, StreamFn } from "@openclaw/llm-core";
import { afterAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import type { AiModelTransportEvent, AiTransformTransportMessages } from "./host.js";

const CUSTOM_API = "openclaw-openai-chatgpt-responses-transport";

function registerCustomApi(registry: ApiRegistry, api: Api, _streamFn: StreamFn): boolean {
  if (registry.getApiProvider(api)) {
    return false;
  }
  const stream = () => createAssistantMessageEventStream();
  registry.registerApiProvider({ api, stream, streamSimple: stream });
  return true;
}

describe("AI transport host configuration", () => {
  let initialHost: import("./host.js").AiTransportHost | undefined;

  it("keeps prewarm call-less and requires callId for fallback events", () => {
    type PrewarmEvent = Extract<AiModelTransportEvent, { type: "connection"; reason: "prewarm" }>;
    type FallbackEvent = Extract<AiModelTransportEvent, { type: "fallback" }>;
    type CoverageEvent = Extract<AiModelTransportEvent, { type: "coverage" }>;

    expectTypeOf<PrewarmEvent>().not.toHaveProperty("callId");
    expectTypeOf<FallbackEvent>().toHaveProperty("callId").toEqualTypeOf<string>();
    expectTypeOf<CoverageEvent>().toHaveProperty("callId").toEqualTypeOf<string>();
  });

  afterAll(async () => {
    if (!initialHost) {
      return;
    }
    const { configureAiTransportHost } = await import("./host.js");
    configureAiTransportHost(initialHost);
  });

  it("replays custom API registration when transports load before the concrete host", async () => {
    const { prepareModelForSimpleCompletion } = await import("./transports.js");
    const { configureAiTransportHost, getAiTransportHost } = await import("./host.js");
    initialHost = getAiTransportHost();
    configureAiTransportHost({});

    const registry = createApiRegistry();
    const sourceModel: Model<"openai-chatgpt-responses"> = {
      id: "gpt-test",
      name: "GPT Test",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const preparedModel = prepareModelForSimpleCompletion({
      apiRegistry: registry,
      model: sourceModel,
    });

    expect(preparedModel).toBe(sourceModel);
    expect(registry.getApiProvider(CUSTOM_API)).toBeUndefined();

    const registrar = vi.fn(registerCustomApi);
    configureAiTransportHost({ registerCustomApi: registrar });
    configureAiTransportHost({ registerCustomApi: registrar });

    const provider = registry.getApiProvider(CUSTOM_API);
    expect(provider).toBeDefined();
    expect(registrar).toHaveBeenCalledOnce();
    expect(provider).toMatchObject({
      api: CUSTOM_API,
      stream: expect.any(Function),
      streamSimple: expect.any(Function),
    });
    const configuredModel = prepareModelForSimpleCompletion({
      apiRegistry: registry,
      model: sourceModel,
    });
    expect(configuredModel.api).toBe(CUSTOM_API);
    expect(provider?.streamSimple(configuredModel, { messages: [] })).toHaveProperty("result");
  });

  it("uses package transcript normalization until the embedding host overrides it", async () => {
    const { configureAiTransportHost, getAiTransportHost } = await import("./host.js");
    configureAiTransportHost({});
    const model: Model<"anthropic-messages"> = {
      id: "claude-text-only",
      name: "Claude Text Only",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: "aW1n", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];

    expect(getAiTransportHost().transformTransportMessages(messages, model)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
        timestamp: 1,
      },
    ]);

    const override = vi.fn(
      (nextMessages: Parameters<AiTransformTransportMessages>[0]) => nextMessages,
    );
    configureAiTransportHost({ transformTransportMessages: override });
    expect(getAiTransportHost().transformTransportMessages(messages, model)).toBe(messages);
    expect(override).toHaveBeenCalledOnce();
  });

  it("forwards transport facts exactly and restores the inert default on reset", async () => {
    const { configureAiTransportHost, getAiTransportHost } = await import("./host.js");
    const observer = vi.fn();
    const events: AiModelTransportEvent[] = [
      {
        type: "attempt",
        eventId: "event-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      },
      {
        type: "provider_fallback",
        eventId: "event-2",
        callId: "call-2",
        provider: "anthropic",
        model: "claude-fable-5",
        api: "anthropic-messages",
        transport: "sse",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      },
      {
        type: "coverage",
        eventId: "event-coverage",
        callId: "call-2",
        provider: "anthropic",
        model: "claude-fable-5",
        api: "anthropic-messages",
        transport: "sse",
        scope: "provider_fallbacks",
        state: "lower_bound",
        reason: "terminal_metadata_unavailable",
      },
      {
        type: "connection",
        eventId: "event-3",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "native-codex-websocket",
        ordinal: 1,
        reason: "prewarm",
        outcome: "completed",
      },
      {
        type: "fallback",
        eventId: "event-4",
        callId: "call-4",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "stream_failure",
      },
    ];

    configureAiTransportHost({ observeModelTransportEvent: observer });
    for (const event of events) {
      getAiTransportHost().observeModelTransportEvent(event);
    }
    expect(observer.mock.calls.map(([event]) => event)).toEqual(events);

    configureAiTransportHost({});
    const firstEvent = events[0];
    if (!firstEvent) {
      throw new Error("expected transport fixture");
    }
    expect(() =>
      getAiTransportHost().observeModelTransportEvent({ ...firstEvent, eventId: "event-5" }),
    ).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(events.length);
  });
});
