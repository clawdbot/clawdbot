import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const promptAndConfigureOllamaMock = vi.hoisted(() =>
  vi.fn(async () => ({
    credential: "ollama-local",
    config: {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    },
  })),
);
const ensureOllamaModelPulledMock = vi.hoisted(() => vi.fn(async () => {}));
const buildOllamaProviderMock = vi.hoisted(() => vi.fn());
const createConfiguredOllamaStreamFnMock = vi.hoisted(() =>
  vi.fn((_params: { model: unknown; providerBaseUrl?: string }) => ({}) as never),
);

vi.mock("./api.js", () => ({
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  configureOllamaNonInteractive: vi.fn(),
  buildOllamaProvider: buildOllamaProviderMock,
}));

vi.mock("./src/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/stream.js")>();
  return {
    ...actual,
    createConfiguredOllamaStreamFn: createConfiguredOllamaStreamFnMock,
  };
});

beforeEach(() => {
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  buildOllamaProviderMock.mockReset();
  createConfiguredOllamaStreamFnMock.mockClear();
});

function registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "ollama",
      name: "Ollama",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

function captureWrappedOllamaPayload(
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "max" | undefined,
) {
  const provider = registerProvider();
  let payloadSeen: Record<string, unknown> | undefined;
  const baseStreamFn = vi.fn((_model, _context, options) => {
    const payload: Record<string, unknown> = {
      messages: [],
      options: { num_ctx: 65536 },
      stream: true,
    };
    options?.onPayload?.(payload, _model);
    payloadSeen = payload;
    return {} as never;
  });

  const wrapped = provider.wrapStreamFn?.({
    config: {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    },
    provider: "ollama",
    modelId: "qwen3.5:9b",
    thinkingLevel,
    model: {
      api: "ollama",
      provider: "ollama",
      id: "qwen3.5:9b",
      baseUrl: "http://127.0.0.1:11434",
      contextWindow: 131_072,
    },
    streamFn: baseStreamFn,
  });

  expect(typeof wrapped).toBe("function");
  void wrapped?.(
    {
      api: "ollama",
      provider: "ollama",
      id: "qwen3.5:9b",
    } as never,
    {} as never,
    {},
  );
  return { baseStreamFn, payloadSeen };
}

describe("ollama plugin", () => {
  it("does not preselect a default model during provider auth setup", async () => {
    const provider = registerProvider();

    const result = await provider.auth[0].run({
      config: {},
      prompter: {} as never,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });

    expect(promptAndConfigureOllamaMock).toHaveBeenCalledWith({
      cfg: {},
      env: undefined,
      opts: undefined,
      prompter: {},
      secretInputMode: undefined,
      allowSecretRefPrompt: undefined,
    });
    expect(result.configPatch).toEqual({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    });
    expect(result.defaultModel).toBeUndefined();
  });

  it("pulls the model the user actually selected", async () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    };
    const prompter = {} as never;

    await provider.onModelSelected?.({
      config,
      model: "ollama/gemma4",
      prompter,
    });

    expect(ensureOllamaModelPulledMock).toHaveBeenCalledWith({
      config,
      model: "ollama/gemma4",
      prompter,
    });
  });

  it("skips ambient discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.discovery.run({
      config: {
        plugins: {
          entries: {
            ollama: {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "", discoveryApiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [{ id: "llama3.2", name: "Llama 3.2" }],
    });

    const result = await provider.discovery.run({
      config: {
        plugins: {
          entries: {
            ollama: {
              config: {
                discovery: { enabled: true },
              },
            },
          },
        },
      },
      env: { OLLAMA_API_KEY: "ollama-live" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-live", discoveryApiKey: "ollama-live" }),
    } as never);

    expect(buildOllamaProviderMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      provider: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [{ id: "llama3.2", name: "Llama 3.2" }],
        apiKey: "ollama-local",
      },
    });
  });

  it("skips ambient discovery without Ollama auth or meaningful config", async () => {
    const provider = registerProvider();

    const result = await provider.discovery.run({
      config: {},
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("skips empty default-ish provider stubs without probing localhost", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("treats non-default baseUrl as explicit discovery config", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://remote-ollama:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://remote-ollama:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://remote-ollama:11434", {
      quiet: false,
    });
  });

  it("accepts baseURL alias as explicit discovery config", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://remote-ollama:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              baseURL: "http://remote-ollama:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://remote-ollama:11434", {
      quiet: false,
    });
  });

  it("keeps stored ollama-local marker auth on the quiet ambient path", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {},
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
    } as never);

    expect(result).toMatchObject({
      provider: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "ollama-local",
        models: [],
      },
    });
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, {
      quiet: true,
    });
  });

  it("resolves dynamic local models from Ollama without generating PI models.json", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-local";
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [
        {
          id: "llama3.2:latest",
          name: "llama3.2:latest",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ],
    });

    try {
      await provider.prepareDynamicModel?.({
        config: {},
        provider: "ollama",
        modelId: "llama3.2:latest",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);

      expect(
        provider.resolveDynamicModel?.({
          config: {},
          provider: "ollama",
          modelId: "llama3.2:latest",
          modelRegistry: { find: vi.fn(() => null) },
        } as never),
      ).toMatchObject({
        provider: "ollama",
        id: "llama3.2:latest",
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      });
      expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, { quiet: true });
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  });

  it("skips implicit localhost discovery when a custom remote Ollama provider is configured", async () => {
    const provider = registerProvider();

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              api: "ollama",
              baseUrl: "https://ollama.com",
              models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
            },
          },
        },
      },
      env: { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-live" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("treats custom 127/8 Ollama providers as loopback for implicit discovery", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            "ollama-alt-local": {
              api: "ollama",
              baseUrl: "http://127.0.0.2:11434",
              models: [{ id: "llama3.2", name: "Llama 3.2" }],
            },
          },
        },
      },
      env: { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-live" }),
    } as never);

    expect(result).toMatchObject({
      provider: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
      },
    });
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, {
      quiet: false,
    });
  });

  it("does not mint synthetic auth for empty default-ish provider stubs", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [],
      },
    });

    expect(auth).toBeUndefined();
  });

  it("mints synthetic auth for non-default explicit ollama config", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseUrl: "http://remote-ollama:11434",
        api: "ollama",
        models: [],
      },
    });

    expect(auth).toEqual({
      apiKey: "ollama-local",
      source: "models.providers.ollama (synthetic local key)",
      mode: "api-key",
    });
  });

  it("mints synthetic auth for non-default baseURL alias config", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseURL: "http://remote-ollama:11434",
        api: "ollama",
        models: [],
      } as never,
    });

    expect(auth).toEqual({
      apiKey: "ollama-local",
      source: "models.providers.ollama (synthetic local key)",
      mode: "api-key",
    });
  });

  it("does not mint synthetic auth for Ollama Cloud baseUrl", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseUrl: "https://ollama.com",
        api: "ollama",
        models: [],
      },
    });

    expect(auth).toBeUndefined();
  });

  it("does not mint synthetic auth for public IPv4 baseUrl", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        baseUrl: "http://8.8.8.8:11434",
        api: "ollama",
        models: [],
      },
    });

    expect(auth).toBeUndefined();
  });

  it("wraps OpenAI-compatible payloads with num_ctx for Ollama compat routes", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      modelId: "qwen3:32b",
      model: {
        api: "openai-completions",
        provider: "ollama",
        id: "qwen3:32b",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 202_752,
      },
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.({} as never, {} as never, {});
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202752);
  });

  it("declares streaming usage support for OpenAI-compatible Ollama routes", () => {
    const provider = registerProvider();

    expect(
      provider.contributeResolvedModelCompat?.({
        modelId: "qwen3:32b",
        provider: "ollama",
        model: {
          api: "openai-completions",
          provider: "ollama",
          id: "qwen3:32b",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      } as never),
    ).toEqual({ supportsUsageInStreaming: true });
    expect(
      provider.contributeResolvedModelCompat?.({
        modelId: "qwen3:32b",
        provider: "custom",
        model: {
          api: "openai-completions",
          provider: "custom",
          id: "qwen3:32b",
          baseUrl: "https://proxy.example.com/v1",
        },
      } as never),
    ).toBeUndefined();
  });

  it("owns replay policy for OpenAI-compatible and native Ollama routes", () => {
    const provider = registerProvider();

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "openai-completions",
        modelId: "qwen3:32b",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "openai-responses",
        modelId: "qwen3:32b",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi: "ollama",
        modelId: "qwen3.5:9b",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("routes createStreamFn to the correct provider baseUrl for ollama2", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: "ollama2", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerBaseUrl: "http://127.0.0.1:11435" }),
    );
  });

  it("routes createStreamFn through baseURL alias for custom Ollama providers", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama2: {
            api: "ollama",
            baseURL: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: "ollama2", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerBaseUrl: "http://127.0.0.1:11435" }),
    );
  });

  it("uses ollama provider baseUrl when provider is ollama (backward compat)", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama" } as never);

    expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerBaseUrl: "http://127.0.0.1:11434" }),
    );
  });

  it("wraps native Ollama payloads with top-level think=false when thinking is off", () => {
    const { baseStreamFn, payloadSeen } = captureWrappedOllamaPayload("off");
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(false);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("keeps native Ollama thinking off by default while exposing opt-in effort levels", () => {
    const provider = registerProvider();

    expect(
      provider.resolveThinkingProfile?.({
        provider: "ollama",
        modelId: "llama3.2:latest",
        reasoning: false,
      }),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });

    expect(
      provider.resolveThinkingProfile?.({
        provider: "ollama",
        modelId: "gemma4:31b",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
  });

  it("wraps native Ollama payloads with top-level think effort when thinking is enabled", () => {
    const { baseStreamFn, payloadSeen } = captureWrappedOllamaPayload("low");
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe("low");
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("maps native Ollama max thinking to the highest supported wire effort", () => {
    const { baseStreamFn, payloadSeen } = captureWrappedOllamaPayload("max");
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe("high");
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("does not set think param when thinkingLevel is undefined", () => {
    const { baseStreamFn, payloadSeen } = captureWrappedOllamaPayload(undefined);
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBeUndefined();
  });

  it("registers an image-capable media understanding provider so image tool can route ollama/*", () => {
    const mediaProviders: Array<{
      id: string;
      capabilities?: string[];
      defaultModels?: Record<string, string>;
      autoPriority?: Record<string, number>;
      describeImage?: unknown;
      describeImages?: unknown;
    }> = [];

    plugin.register(
      createTestPluginApi({
        id: "ollama",
        name: "Ollama",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider() {},
        registerMediaUnderstandingProvider(provider) {
          mediaProviders.push(provider);
        },
      }),
    );

    expect(mediaProviders).toHaveLength(1);
    const [ollamaMedia] = mediaProviders;
    expect(ollamaMedia.id).toBe("ollama");
    expect(ollamaMedia.capabilities).toEqual(["image"]);
    expect(typeof ollamaMedia.describeImage).toBe("function");
    expect(typeof ollamaMedia.describeImages).toBe("function");
    // Intentional: no defaultModels or autoPriority. Ollama vision models are
    // user-installed (llava, qwen2.5vl, …) with no universal default, and we
    // don't want Ollama to auto-steal image duty from configured providers.
    expect(ollamaMedia.defaultModels).toBeUndefined();
    expect(ollamaMedia.autoPriority).toBeUndefined();
  });
});
