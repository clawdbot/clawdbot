import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { Api, Model, StreamFn } from "@openclaw/llm-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import type { AiTransformTransportMessages } from "./host.js";

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
});
