import { createApiRegistry, type ApiRegistry } from "@openclaw/ai";
// Simple completion transport tests cover provider-specific stream alias
// selection before the generic completion helper invokes the LLM layer.
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createMoonshotThinkingWrapper } from "../llm/providers/stream-wrappers/moonshot-thinking.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import type { StreamFn } from "./runtime/index.js";

const createAnthropicVertexStreamFnForModel = vi.fn();
const ensureCustomApiRegistered = vi.fn();
const resolveProviderStreamFn = vi.fn();
const wrapProviderSimpleCompletionStreamFn = vi.fn();
const buildTransportAwareSimpleStreamFn = vi.fn();
const createOpenClawTransportStreamFnForModel = vi.fn();
const createTransportAwareStreamFnForModel = vi.fn();
const prepareTransportAwareSimpleModel = vi.fn();
const resolveTransportAwareSimpleApi = vi.fn();
const prepareGoogleSimpleCompletionModel = vi.fn((_registry: unknown, model: unknown) => model);
const pluginStreamFn = vi.fn(() => "plugin-stream-result" as never);

vi.mock("./anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel,
}));

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

vi.mock("./google-simple-completion-stream.js", () => ({
  prepareGoogleSimpleCompletionModel,
}));

vi.mock("./provider-transport-stream.js", () => ({
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderStreamFn,
    wrapProviderSimpleCompletionStreamFn,
  };
});

let prepareModelForSimpleCompletionImpl: typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion;
let apiRegistry: ApiRegistry;
const SIMPLE_COMPLETION_SOURCE_ID = "test:simple-completion-transport";

function prepareModelForSimpleCompletion(
  params: Omit<
    Parameters<
      typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion
    >[0],
    "apiRegistry"
  >,
) {
  return prepareModelForSimpleCompletionImpl({ ...params, apiRegistry });
}

describe("prepareModelForSimpleCompletion", () => {
  beforeAll(async () => {
    // Dynamic import lets the mocked transport/provider modules settle before
    // the unit under test captures custom stream registration helpers.
    ({ prepareModelForSimpleCompletion: prepareModelForSimpleCompletionImpl } =
      await import("./simple-completion-transport.js"));
  });

  beforeEach(() => {
    apiRegistry = createApiRegistry();
    createAnthropicVertexStreamFnForModel.mockReset();
    ensureCustomApiRegistered.mockReset();
    resolveProviderStreamFn.mockReset();
    pluginStreamFn.mockClear();
    wrapProviderSimpleCompletionStreamFn.mockReset();
    buildTransportAwareSimpleStreamFn.mockReset();
    createOpenClawTransportStreamFnForModel.mockReset();
    createTransportAwareStreamFnForModel.mockReset();
    prepareTransportAwareSimpleModel.mockReset();
    resolveTransportAwareSimpleApi.mockReset();
    prepareGoogleSimpleCompletionModel.mockReset();
    createAnthropicVertexStreamFnForModel.mockReturnValue("vertex-stream");
    resolveProviderStreamFn.mockReturnValue(pluginStreamFn);
    wrapProviderSimpleCompletionStreamFn.mockReturnValue(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValue(undefined);
    createOpenClawTransportStreamFnForModel.mockReturnValue(undefined);
    createTransportAwareStreamFnForModel.mockReturnValue(undefined);
    prepareTransportAwareSimpleModel.mockImplementation((model) => model);
    resolveTransportAwareSimpleApi.mockReturnValue(undefined);
    prepareGoogleSimpleCompletionModel.mockImplementation((_registry, model) => model);
  });

  it("routes provider-owned simple-completion wrappers through an internal API alias", () => {
    const sourceApi = "moonshot-simple-source";
    const sourceResult = { source: true };
    let capturedApi: string | undefined;
    apiRegistry.registerApiProvider(
      {
        api: sourceApi,
        stream: () => sourceResult as never,
        streamSimple: (runtimeModel) => {
          capturedApi = runtimeModel.api;
          return sourceResult as never;
        },
      },
      SIMPLE_COMPLETION_SOURCE_ID,
    );
    wrapProviderSimpleCompletionStreamFn.mockImplementationOnce(({ context }) =>
      createMoonshotThinkingWrapper(context.streamFn),
    );
    const model: Model = {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      api: sourceApi,
      provider: "moonshot",
      baseUrl: "https://api.moonshot.ai/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 262_144,
    };

    const result = prepareModelForSimpleCompletion({ model });

    expect(wrapProviderSimpleCompletionStreamFn).toHaveBeenCalledTimes(1);
    expect(wrapProviderSimpleCompletionStreamFn.mock.results[0]?.value).toBeTypeOf("function");
    expect(result.api).toBe(
      "openclaw-provider-simple:moonshot:kimi-k2.7-code:moonshot-simple-source:https%3A%2F%2Fapi.moonshot.ai%2Fv1",
    );
    expect(wrapProviderSimpleCompletionStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "moonshot",
        context: expect.objectContaining({
          provider: "moonshot",
          modelId: "kimi-k2.7-code",
          model,
          streamFn: expect.any(Function),
        }),
      }),
    );
    const registeredStream = ensureCustomApiRegistered.mock.calls.at(-1)?.[2];
    expect(registeredStream).toBeTypeOf("function");
    const stream = registeredStream(result, { messages: [] }, {});
    expect(stream).toBe(sourceResult);
    expect(stream).not.toBeInstanceOf(Promise);
    expect(capturedApi).toBe(sourceApi);
  });

  it("registers the configured Ollama transport and keeps the original api", () => {
    const secret = "ollama-provider-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:ollama" });
    const model: Model<"ollama"> = {
      id: "llama3",
      name: "Llama 3",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
      headers: { Authorization: `Bearer ${sentinel}` },
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            models: [],
          },
        },
      },
    };

    const result = prepareModelForSimpleCompletion({
      model,
      cfg,
    });

    expect(resolveProviderStreamFn).toHaveBeenCalledTimes(1);
    const [request] = resolveProviderStreamFn.mock.calls.at(0) as [
      {
        provider?: unknown;
        config?: unknown;
        context?: { provider?: unknown; modelId?: unknown; model?: unknown };
      },
    ];
    expect(request.provider).toBe("ollama");
    expect(request.config).toBe(cfg);
    expect(request.context?.provider).toBe("ollama");
    expect(request.context?.modelId).toBe("llama3");
    expect(request.context?.model).toEqual({
      ...model,
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "ollama",
      expect.any(Function),
    );
    const registeredStream = ensureCustomApiRegistered.mock.calls[0]?.[2] as StreamFn;
    void registeredStream(
      { ...model, headers: { Authorization: `Bearer ${sentinel}` } } as never,
      {} as never,
      { apiKey: sentinel, headers: { "X-Managed": `Bearer ${sentinel}` } } as never,
    );
    expect(pluginStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: `Bearer ${secret}` } }),
      {},
      { apiKey: secret, headers: { "X-Managed": `Bearer ${secret}` } },
    );
    expect(result).toBe(model);
  });

  it("uses a custom api alias for Anthropic Vertex simple completions", () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);

    const result = prepareModelForSimpleCompletion({ model });

    expect(createAnthropicVertexStreamFnForModel).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
      "vertex-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
    });
  });

  it("uses a transport-aware custom api alias when llm request transport overrides are present", () => {
    const model: Model<"openai-responses"> = {
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValueOnce("transport-stream");
    prepareTransportAwareSimpleModel.mockReturnValueOnce({
      ...model,
      api: "openclaw-openai-responses-transport",
    });

    const result = prepareModelForSimpleCompletion({ model });

    expect(prepareTransportAwareSimpleModel).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(buildTransportAwareSimpleStreamFn).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-openai-responses-transport",
      "transport-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-openai-responses-transport",
    });
  });

  it("uses the Google simple-completion sanitizer alias after transport checks pass through", () => {
    const model: Model<"google-generative-ai"> = {
      id: "gemini-flash-latest",
      name: "Gemini Flash Latest",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8192,
      headers: {},
    };
    prepareGoogleSimpleCompletionModel.mockImplementationOnce((_registry: unknown, m: unknown) => ({
      ...(m as Model<"google-generative-ai">),
      api: "openclaw-google-generative-ai-simple",
    }));
    resolveProviderStreamFn.mockReturnValueOnce(undefined);

    const result = prepareModelForSimpleCompletion({ model });

    expect(prepareTransportAwareSimpleModel).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(prepareGoogleSimpleCompletionModel).toHaveBeenCalledWith(apiRegistry, model);
    expect(buildTransportAwareSimpleStreamFn).not.toHaveBeenCalled();
    expect(result).toEqual({
      ...model,
      api: "openclaw-google-generative-ai-simple",
    });
  });

  it("keeps Google transport-aware models on the transport alias", () => {
    const model: Model<"google-generative-ai"> = {
      id: "gemini-flash-latest",
      name: "Gemini Flash Latest",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8192,
      headers: {},
    };

    const transportModel = {
      ...model,
      api: "openclaw-google-generative-ai-transport",
    };
    resolveProviderStreamFn.mockReturnValueOnce(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValueOnce("google-transport-stream");
    prepareTransportAwareSimpleModel.mockReturnValueOnce(transportModel);

    const result = prepareModelForSimpleCompletion({ model });

    expect(buildTransportAwareSimpleStreamFn).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-google-generative-ai-transport",
      "google-transport-stream",
    );
    expect(prepareGoogleSimpleCompletionModel).not.toHaveBeenCalled();
    expect(result).toBe(transportModel);
  });

  it.each([
    ["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex"],
    ["https://chatgpt.com/backend-api/v1", "https://chatgpt.com/backend-api/codex"],
    ["https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex"],
    ["https://chatgpt.com/backend-api/codex/v1", "https://chatgpt.com/backend-api/codex"],
    ["https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex"],
    ["https://proxy.example.test/openai", "https://proxy.example.test/openai/codex"],
    [
      "https://proxy.example.test/openai/codex/responses",
      "https://proxy.example.test/openai/codex",
    ],
  ])(
    "uses OpenClaw transport for OpenAI Codex-response simple completions with baseUrl %s",
    (baseUrl, expectedBaseUrl) => {
      const model: Model<"openai-chatgpt-responses"> = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };

      resolveProviderStreamFn.mockReturnValueOnce(undefined);
      createOpenClawTransportStreamFnForModel.mockReturnValueOnce("codex-transport-stream");
      resolveTransportAwareSimpleApi.mockReturnValueOnce("openclaw-openai-responses-transport");

      const result = prepareModelForSimpleCompletion({ model });

      // ChatGPT/Codex response endpoints share the transport stream, but the
      // simple-completion API must normalize caller-supplied base URLs first.
      expect(createOpenClawTransportStreamFnForModel).toHaveBeenCalledWith(
        {
          ...model,
          baseUrl: expectedBaseUrl,
        },
        { cfg: undefined },
      );
      expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
        apiRegistry,
        "openclaw-openai-responses-transport",
        "codex-transport-stream",
      );
      expect(result).toEqual({
        ...model,
        baseUrl: expectedBaseUrl,
        api: "openclaw-openai-responses-transport",
      });
      expect(prepareTransportAwareSimpleModel).not.toHaveBeenCalled();
    },
  );
});
