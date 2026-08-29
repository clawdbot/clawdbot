// Meta tests cover plugin registration and catalog shape.
import {
  configureAiTransportHost,
  createApiRegistry,
  createAssistantMessageEventStream,
  createLlmRuntime,
  getAiTransportHost,
  type Api,
  type AssistantMessageEventStreamContract,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@openclaw/ai";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMetaProvider } from "./api.js";
import plugin from "./index.js";
import { wrapMetaProviderStream } from "./stream.js";

const CATALOG_CAP_MODEL_ID = "muse-spark-1.2";
const initialAiTransportHost = getAiTransportHost();

function resolveCatalogModel(modelId: string): Model<"openai-responses"> {
  const provider = buildMetaProvider();
  const catalogModel = provider.models.find((model) => model.id === modelId);
  if (!catalogModel) {
    throw new Error(`Expected ${modelId} in Meta catalog`);
  }
  return {
    provider: "meta",
    baseUrl: provider.baseUrl,
    ...catalogModel,
    api: "openai-responses",
  } as Model<"openai-responses">;
}

function completedSseResponse(): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_meta_catalog_cap",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  };
  return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function requireSynchronousStream(
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (
    stream instanceof Promise ||
    !("push" in stream) ||
    !("end" in stream) ||
    typeof stream.push !== "function" ||
    typeof stream.end !== "function"
  ) {
    throw new Error("Expected synchronous assistant event stream");
  }
  return stream as AssistantMessageEventStreamContract;
}

function requireThinkingProfileResolver(
  provider: ReturnType<typeof capturePluginRegistration>["providers"][number],
) {
  if (!provider.resolveThinkingProfile) {
    throw new Error("Expected resolveThinkingProfile on Meta provider");
  }
  return provider.resolveThinkingProfile;
}

describe("meta provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureAiTransportHost(initialAiTransportHost);
  });

  it("registers the Meta provider with api-key auth", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    expect(provider).toMatchObject({
      id: "meta",
      label: "Meta",
      docsPath: "/providers/meta",
    });
    expect(provider.wrapStreamFn).toBe(wrapMetaProviderStream);
    expect(provider.wrapSimpleCompletionStreamFn).toBe(wrapMetaProviderStream);
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      label: "Meta API key",
      starterModel: "meta/muse-spark-1.1",
    });
  });

  it("registers the Meta muse-image image-generation provider on the same entry", () => {
    const captured = capturePluginRegistration(plugin);
    const [imageProvider] = captured.imageGenerationProviders;
    if (!imageProvider) {
      throw new Error("Expected Meta image-generation provider");
    }
    expect(imageProvider).toMatchObject({
      id: "meta",
      label: "Meta",
      defaultModel: "muse-image-1.0",
    });
    expect(imageProvider.models).toContain("muse-image-1.0");
    // muse-image supports single-reference edits via /v1/images/edits.
    expect(imageProvider.capabilities.edit?.enabled).toBe(true);
  });

  it("does not wrap projected non-Responses Meta models for either stream hook", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const model = {
      ...resolveCatalogModel(CATALOG_CAP_MODEL_ID),
      api: "openclaw-provider-stream:meta:muse-spark-1.2",
    } as Model;

    for (const hook of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      if (!hook) {
        throw new Error("Expected Meta stream hook");
      }
      let capturedPayload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = (streamModel, _context, options) => {
        const payload: Record<string, unknown> = {};
        options?.onPayload?.(payload, streamModel);
        capturedPayload = payload;
        return {} as ReturnType<StreamFn>;
      };
      const wrapped = hook({
        provider: "meta",
        modelId: model.id,
        model,
        sourceApi: "openai-completions",
        streamFn: baseStreamFn,
      });

      expect(wrapped).toBeUndefined();
      void (wrapped ?? baseStreamFn)(model, { messages: [] }, { maxTokens: 0 });
      expect(capturedPayload).toEqual({});
    }
  });

  it("wraps projected direct completions from a Responses source API", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider?.wrapSimpleCompletionStreamFn) {
      throw new Error("Expected Meta direct completion stream wrapper");
    }
    const model = {
      ...resolveCatalogModel(CATALOG_CAP_MODEL_ID),
      api: "openclaw-provider-stream:meta:muse-spark-1.2",
    } as Model;
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (streamModel, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, streamModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider.wrapSimpleCompletionStreamFn({
      provider: "meta",
      modelId: model.id,
      model,
      sourceApi: "openai-responses",
      streamFn: baseStreamFn,
    });
    if (!wrapped) {
      throw new Error("Expected projected Meta Responses stream wrapper");
    }

    void wrapped(model, { messages: [] }, { maxTokens: 0 });

    expect(capturedPayload).toMatchObject({
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 131072,
      store: false,
    });
  });

  it("builds the muse-spark-1.1 catalog entry over openai-responses", () => {
    const providerConfig = buildMetaProvider();
    expect(providerConfig.baseUrl).toBe("https://api.meta.ai/v1");
    expect(providerConfig.api).toBe("openai-responses");
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.1");
    if (!model) {
      throw new Error("Expected muse-spark-1.1 model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 0,
    });
  });

  it("builds the muse-spark-1.2 catalog entry over openai-responses", () => {
    const providerConfig = buildMetaProvider();
    expect(providerConfig.baseUrl).toBe("https://api.meta.ai/v1");
    expect(providerConfig.api).toBe("openai-responses");
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.2");
    if (!model) {
      throw new Error("Expected muse-spark-1.2 model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 0,
    });
  });

  it("preserves the provider-selected output cap when the caller omits it", async () => {
    const model = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
    let capturedPayload: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetchMock);
    const streamFn = wrapMetaProviderStream({
      provider: "meta",
      modelId: model.id,
      model,
      streamFn: streamSimple,
    });
    if (!streamFn) {
      throw new Error("Expected Meta Responses stream wrapper");
    }

    const context: Context = {
      messages: [{ role: "user", content: "Catalog cap probe", timestamp: 0 }],
    };
    const stream = await streamFn(model, context, {
      apiKey: "unit-test-token",
      maxRetries: 0,
      onPayload: (payload) => {
        capturedPayload = payload as Record<string, unknown>;
      },
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedPayload).not.toHaveProperty("max_output_tokens");
  });

  it("preserves Meta replay fields through canonical simple-completion aliases", async () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider?.wrapSimpleCompletionStreamFn) {
      throw new Error("Expected Meta direct completion stream wrapper");
    }

    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const model = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
    let capturedPayload: Record<string, unknown> | undefined;
    let sourceModelApi: Api | undefined;
    const sourceStreamFn: StreamFunction<"openai-responses", SimpleStreamOptions> = (
      streamModel,
      _context,
      options,
    ) => {
      sourceModelApi = streamModel.api;
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, streamModel);
      capturedPayload = payload;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: { stopReason: "stop" } as never,
        });
        stream.end();
      });
      return stream;
    };
    registry.registerApiProvider({
      api: "openai-responses",
      stream: sourceStreamFn,
      streamSimple: sourceStreamFn,
    });
    configureAiTransportHost({
      ...initialAiTransportHost,
      registerCustomApi: (apiRegistry, api, streamFn) => {
        if (apiRegistry.getApiProvider(api)) {
          return false;
        }
        apiRegistry.registerApiProvider({
          api,
          stream: (streamModel, streamContext, options) =>
            requireSynchronousStream(streamFn(streamModel, streamContext, options)),
          streamSimple: (streamModel, streamContext, options) =>
            requireSynchronousStream(streamFn(streamModel, streamContext, options)),
        });
        return true;
      },
      plugin: {
        ...initialAiTransportHost.plugin,
        resolveProviderStream: () => undefined,
        wrapSimpleCompletionStream: ({ provider: providerId, context }) => {
          if (providerId !== "meta") {
            return undefined;
          }
          return (
            provider.wrapSimpleCompletionStreamFn?.({
              agentDir: context.agentDir,
              workspaceDir: context.workspaceDir,
              provider: context.provider,
              modelId: context.modelId,
              model: context.model,
              streamFn: context.streamFn,
            }) ?? undefined
          );
        },
      },
    });

    const preparedModel = prepareModelForSimpleCompletion({ apiRegistry: registry, model });
    expect(preparedModel.api).toMatch(/^openclaw-provider-simple:/);

    const result = await runtime.completeSimple(preparedModel, { messages: [] });

    expect(result.stopReason).toBe("stop");
    expect(sourceModelApi).toBe("openai-responses");
    expect(capturedPayload).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(capturedPayload).not.toHaveProperty("max_output_tokens");
  });

  it.each([
    {
      label: "an omitted override",
      callerMaxTokens: undefined,
      prepopulatedMaxOutputTokens: undefined,
      expectedMaxOutputTokens: undefined,
    },
    {
      label: "a positive caller override",
      callerMaxTokens: 4096,
      prepopulatedMaxOutputTokens: undefined,
      expectedMaxOutputTokens: 4096,
    },
    {
      label: "an explicit zero treated as unset by the Responses transport",
      callerMaxTokens: 0,
      prepopulatedMaxOutputTokens: undefined,
      expectedMaxOutputTokens: 131072,
    },
    {
      label: "a pre-populated payload cap",
      callerMaxTokens: undefined,
      prepopulatedMaxOutputTokens: 2048,
      expectedMaxOutputTokens: 2048,
    },
    {
      label: "a pre-populated payload cap with an explicit zero caller cap",
      callerMaxTokens: 0,
      prepopulatedMaxOutputTokens: 2048,
      expectedMaxOutputTokens: 2048,
    },
  ])(
    "preserves catalog cap precedence through the direct completion hook for $label",
    (testCase) => {
      const captured = capturePluginRegistration(plugin);
      const [provider] = captured.providers;
      if (!provider?.wrapSimpleCompletionStreamFn) {
        throw new Error("Expected Meta direct completion stream wrapper");
      }
      const model = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
      let capturedPayload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = (streamModel, _context, options) => {
        const payload: Record<string, unknown> = {};
        if (testCase.prepopulatedMaxOutputTokens !== undefined) {
          payload.max_output_tokens = testCase.prepopulatedMaxOutputTokens;
        }
        if (options?.maxTokens) {
          payload.max_output_tokens = options.maxTokens;
        }
        options?.onPayload?.(payload, streamModel);
        return {} as ReturnType<StreamFn>;
      };
      const streamFn = provider.wrapSimpleCompletionStreamFn({
        provider: "meta",
        modelId: model.id,
        model,
        streamFn: baseStreamFn,
      });
      if (!streamFn) {
        throw new Error("Expected Meta Responses stream wrapper");
      }

      void streamFn(
        model,
        { messages: [] },
        {
          ...(testCase.callerMaxTokens === undefined
            ? {}
            : { maxTokens: testCase.callerMaxTokens }),
          onPayload: (payload) => {
            capturedPayload = payload as Record<string, unknown>;
          },
        },
      );

      expect(capturedPayload?.max_output_tokens).toBe(testCase.expectedMaxOutputTokens);
    },
  );

  it("builds the discounted muse-spark-1.2-contributor catalog entry", () => {
    const providerConfig = buildMetaProvider();
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.2-contributor");
    if (!model) {
      throw new Error("Expected muse-spark-1.2-contributor model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    });
  });

  it("publishes a non-empty display name for every catalog model", () => {
    const models = buildMetaProvider().models;
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "muse-spark-1.1", name: "Muse Spark 1.1" },
      { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
      { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
    ]);
    expect(models.every((model) => model.name.trim().length > 0)).toBe(true);
  });

  it("advertises a high default thinking profile for every reasoning model", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const reasoningModels = buildMetaProvider().models.filter((model) => model.reasoning);
    expect(reasoningModels.map((model) => model.id)).toEqual([
      "muse-spark-1.1",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);
    for (const model of reasoningModels) {
      const profile = resolveThinkingProfile({
        provider: "meta",
        modelId: model.id,
        reasoning: model.reasoning,
      });
      expect(profile?.defaultLevel).toBe("high");
      expect(profile?.levels.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(
        resolveThinkingProfile({
          provider: "meta",
          modelId: model.id,
        })?.defaultLevel,
      ).toBe("high");
    }
  });

  it("respects an explicit non-reasoning catalog fact", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    expect(
      resolveThinkingProfile({
        provider: "meta",
        modelId: "muse-spark-1.2",
        reasoning: false,
      }),
    ).toBeUndefined();
  });
});
