// Ollama tests cover index plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import {
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { OLLAMA_DEFAULT_API_KEY } from "./src/discovery-shared.js";

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
const queryOllamaModelShowInfoMock = vi.hoisted(() => vi.fn());
const buildOllamaModelDefinitionMock = vi.hoisted(() =>
  vi.fn((modelId: string, contextWindow?: number, capabilities?: string[]) => {
    const normalized = modelId.trim().toLowerCase();
    const isKnownCloudReasoningModel =
      normalized === "glm-5.2:cloud" || /^deepseek-v4-(?:flash|pro):cloud$/.test(normalized);
    return {
      id: modelId,
      name: modelId,
      reasoning: isKnownCloudReasoningModel || (capabilities?.includes("thinking") ?? false),
      input: capabilities?.includes("vision") ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow ?? (normalized === "glm-5.2:cloud" ? 1_000_000 : 8192),
      maxTokens: 8192,
      compat: capabilities
        ? { supportsTools: capabilities.includes("tools"), supportsUsageInStreaming: true }
        : { supportsUsageInStreaming: true },
    };
  }),
);
const createConfiguredOllamaStreamFnMock = vi.hoisted(() =>
  vi.fn((_params: { model: unknown; providerBaseUrl?: string }) => ({}) as never),
);

vi.mock("./api.js", () => ({
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  configureOllamaNonInteractive: vi.fn(),
  buildOllamaProvider: buildOllamaProviderMock,
  queryOllamaModelShowInfo: queryOllamaModelShowInfoMock,
  buildOllamaModelDefinition: buildOllamaModelDefinitionMock,
}));

vi.mock("./src/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/stream.js")>();
  return {
    ...actual,
    createConfiguredOllamaStreamFn: createConfiguredOllamaStreamFnMock,
  };
});

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  buildOllamaProviderMock.mockReset();
  queryOllamaModelShowInfoMock.mockReset();
  queryOllamaModelShowInfoMock.mockResolvedValue({
    contextWindow: 32_768,
    capabilities: ["completion", "tools"],
  });
  buildOllamaModelDefinitionMock.mockClear();
  createConfiguredOllamaStreamFnMock.mockClear();
});

function registerProvider() {
  return registerProvidersWithPluginConfig({}).find((provider) => provider.id === "ollama");
}

function registerProvidersWithPluginConfig(pluginConfig: Record<string, unknown>) {
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

  expect(registerProviderMock).toHaveBeenCalledTimes(2);
  return registerProviderMock.mock.calls.map((call) => call[0]);
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  return registerProvidersWithPluginConfig(pluginConfig).find(
    (provider) => provider.id === "ollama",
  );
}

function registerOllamaCloudProvider() {
  return registerProvidersWithPluginConfig({}).find((provider) => provider.id === "ollama-cloud");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireConfiguredStreamParams(): Record<string, unknown> {
  return requireRecord(createConfiguredOllamaStreamFnMock.mock.calls[0]?.[0], "stream params");
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

  if (!wrapped) {
    throw new Error("expected Ollama thinking stream wrapper");
  }
  void wrapped(
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
  it.each(["ollama", "ollama-cloud"])(
    "classifies incomplete %s streams as provider failures",
    (providerId) => {
      const provider = registerProvidersWithPluginConfig({}).find(
        (candidate) => candidate.id === providerId,
      );

      expect(
        provider?.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "Ollama API stream ended without a final response",
        }),
      ).toBe("server_error");
      expect(
        provider?.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "Ollama returned malformed tool arguments",
        }),
      ).toBeUndefined();
    },
  );

  it("registers node-local inference commands, policy, and agent tool", () => {
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "ollama",
        name: "Ollama",
        source: "test",
        registerNodeHostCommand,
        registerNodeInvokePolicy,
        registerTool,
      }),
    );

    expect(registerNodeHostCommand.mock.calls.map(([entry]) => entry.command)).toEqual([
      "ollama.models",
      "ollama.chat",
    ]);
    expect(registerNodeInvokePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ["ollama.models", "ollama.chat"],
        defaultPlatforms: ["macos", "linux", "windows"],
      }),
    );
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "node_inference" }));
  });

  it("keeps the agent tool but does not advertise node inference when disabled locally", () => {
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "ollama",
        name: "Ollama",
        source: "test",
        pluginConfig: { nodeInference: { enabled: false } },
        registerNodeHostCommand,
        registerNodeInvokePolicy,
        registerTool,
      }),
    );

    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(registerNodeInvokePolicy).toHaveBeenCalledOnce();
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "node_inference" }));
  });

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

  it("discovers and prepares an installed tool-capable model without pulling it", async () => {
    const provider = registerProvider();
    const guided = provider.auth[0].appGuidedSetup;
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [
        { id: "embed-only", name: "embed-only", compat: { supportsTools: false } },
        { id: "unknown-tools", name: "unknown-tools" },
        { id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } },
      ],
    });

    await expect(guided?.detect({ config: {}, env: {} })).resolves.toEqual({
      modelRef: "ollama/qwen-tool",
      detail: "qwen-tool at http://127.0.0.1:11434",
    });
    const prepared = await guided?.prepare({
      config: {},
      env: {},
      modelRef: "ollama/qwen-tool",
    });
    expect(prepared).toMatchObject({
      profiles: [],
      defaultModel: "ollama/qwen-tool",
      configPatch: {
        models: {
          mode: "merge",
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [
                expect.objectContaining({ id: "embed-only" }),
                expect.objectContaining({ id: "unknown-tools" }),
                expect.objectContaining({ id: "qwen-tool" }),
              ],
            },
          },
        },
      },
    });
    expect(prepared?.configPatch?.models?.providers?.ollama?.apiKey).toBe(OLLAMA_DEFAULT_API_KEY);
    await expect(
      guided?.prepare({ config: {}, env: {}, modelRef: "ollama/unknown-tools" }),
    ).resolves.toBeNull();
    expect(ensureOllamaModelPulledMock).not.toHaveBeenCalled();
  });

  it("prefers the strongest tool-calling family among installed models", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [
        { id: "llama3.3:70b", name: "llama3.3:70b", compat: { supportsTools: true } },
        { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
        {
          id: "nomic-embed-text",
          name: "nomic-embed-text",
          compat: { supportsTools: true },
        },
      ],
    });

    await expect(provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} })).resolves.toEqual(
      {
        modelRef: "ollama/qwen3.5:4b",
        detail: "qwen3.5:4b at http://127.0.0.1:11434",
      },
    );
  });

  it("skips preferred models whose measured context is below 16k", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [
        { id: "llama3.3:70b", name: "llama3.3:70b", compat: { supportsTools: true } },
        { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
      ],
    });
    queryOllamaModelShowInfoMock.mockImplementation(async (_baseUrl: string, modelId: string) => ({
      contextWindow: modelId === "qwen3.5:4b" ? 8_192 : 16_384,
      capabilities: ["completion", "tools"],
    }));

    await expect(provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} })).resolves.toEqual(
      {
        modelRef: "ollama/llama3.3:70b",
        detail: "llama3.3:70b at http://127.0.0.1:11434",
      },
    );
  });

  it("does not auto-detect a model without measured context metadata", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [{ id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } }],
    });
    queryOllamaModelShowInfoMock.mockResolvedValue({
      capabilities: ["completion", "tools"],
    });

    await expect(
      provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} }),
    ).resolves.toBeNull();
  });

  it("uses configured Ollama access while discovering installed models", async () => {
    const provider = registerProvider();
    const configuredValue = "configured-access";
    const providerAccess = { apiKey: configuredValue };
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "https://ollama.example.com",
      api: "ollama",
      models: [{ id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } }],
    });

    await provider.auth[0].appGuidedSetup?.detect({
      config: {
        models: {
          providers: {
            ollama: {
              ...providerAccess,
              baseUrl: "https://ollama.example.com",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: {},
    });

    expect(buildOllamaProviderMock).toHaveBeenCalledWith(
      "https://ollama.example.com",
      expect.objectContaining(providerAccess),
    );
  });

  it("keeps environment-backed Ollama access for the completion proposal", async () => {
    const provider = registerProvider();
    const configuredValue = "environment-access";
    const providerAccess = { apiKey: configuredValue };
    const environment = { OLLAMA_API_KEY: configuredValue };
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "https://ollama.example.com",
      api: "ollama",
      models: [{ id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } }],
    });

    const prepared = await provider.auth[0].appGuidedSetup?.prepare({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.example.com",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      env: environment,
      modelRef: "ollama/qwen-tool",
    });

    expect(buildOllamaProviderMock).toHaveBeenCalledWith(
      "https://ollama.example.com",
      expect.objectContaining(providerAccess),
    );
    expect(prepared?.configPatch?.models?.providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
  });

  it("does not send the ambient Ollama cloud key to automatic localhost discovery", async () => {
    const provider = registerProvider();
    const configuredValue = "cloud-access";
    const environment = { OLLAMA_API_KEY: configuredValue };
    buildOllamaProviderMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [{ id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } }],
    });

    await provider.auth[0].appGuidedSetup?.detect({ config: {}, env: environment });

    const options = buildOllamaProviderMock.mock.calls.at(-1)?.[1] as
      | { apiKey?: string; quiet?: boolean }
      | undefined;
    expect(options?.apiKey).toBeUndefined();
  });

  it("honors the Ollama discovery opt-out during app-guided detection", async () => {
    const provider = registerProvider();

    await expect(
      provider.auth[0].appGuidedSetup?.detect({
        config: {
          plugins: { entries: { ollama: { config: { discovery: { enabled: false } } } } },
        },
        env: {},
      }),
    ).resolves.toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
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

    const result = await provider.catalog.run({
      config: {},
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
    } as never);

    const resultProvider = requireRecord(result?.provider, "catalog provider");
    expect(resultProvider.baseUrl).toBe("http://127.0.0.1:11434");
    expect(resultProvider.api).toBe("ollama");
    expect(resultProvider.apiKey).toBe("ollama-local");
    expect(resultProvider.models).toEqual([]);
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, {
      quiet: true,
    });
  });

  it("resolves dynamic local models from Ollama without generating static models.json", async () => {
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

      const resolved = provider.resolveDynamicModel?.({
        config: {},
        provider: "ollama",
        modelId: "llama3.2:latest",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);
      expect(resolved?.provider).toBe("ollama");
      expect(resolved?.id).toBe("llama3.2:latest");
      expect(resolved?.api).toBe("ollama");
      expect(resolved?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, { quiet: true });
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  });

  it("preserves explicit api for configured dynamic Ollama models", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-live";
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "https://ollama.example.com",
      api: "ollama",
      models: [
        {
          id: "qwen3-coder:cloud",
          name: "qwen3-coder:cloud",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ],
    });

    try {
      const config = {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.example.com/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      };

      await provider.prepareDynamicModel?.({
        config,
        provider: "ollama",
        modelId: "qwen3-coder:cloud",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);

      const resolved = provider.resolveDynamicModel?.({
        config,
        provider: "ollama",
        modelId: "qwen3-coder:cloud",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);
      expect(resolved?.provider).toBe("ollama");
      expect(resolved?.id).toBe("qwen3-coder:cloud");
      expect(resolved?.api).toBe("openai-completions");
      expect(resolved?.baseUrl).toBe("https://ollama.example.com/v1");
      expect(buildOllamaProviderMock).toHaveBeenCalledWith("https://ollama.example.com/v1", {
        quiet: true,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  });

  it("resolves requested Ollama cloud models that are omitted from tags but confirmed by show", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-local";
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [
        {
          id: "kimi-k2.5:cloud",
          name: "kimi-k2.5:cloud",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 8192,
        },
      ],
    });
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1048576,
      capabilities: ["completion", "tools"],
    });

    try {
      await provider.prepareDynamicModel?.({
        config: {},
        provider: "ollama",
        modelId: "deepseek-v4-pro:cloud",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);

      expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
        "http://127.0.0.1:11434",
        "deepseek-v4-pro:cloud",
      );
      const resolved = provider.resolveDynamicModel?.({
        config: {},
        provider: "ollama",
        modelId: "deepseek-v4-pro:cloud",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);
      expect(resolved?.provider).toBe("ollama");
      expect(resolved?.id).toBe("deepseek-v4-pro:cloud");
      expect(resolved?.api).toBe("ollama");
      expect(resolved?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(resolved?.reasoning).toBe(true);
      expect(resolved?.compat?.supportsTools).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  });

  it("augments exact configured Ollama refs with live show capabilities", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/minimax-m3:cloud@work": {},
            },
          },
        },
      },
      env: process.env,
      entries: [],
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "minimax-m3:cloud",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        api: "ollama",
        reasoning: true,
        contextWindow: 1_048_576,
        compat: {
          supportsTools: true,
          supportsUsageInStreaming: true,
        },
      }),
    ]);
  });

  it("augments Ollama fallback and per-agent configured refs", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValue({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            heartbeat: {
              model: "ollama/heartbeat:cloud",
            },
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["ollama/global-fallback:cloud"],
            },
          },
          entries: {
            ops: {
              model: {
                primary: "ollama/per-agent:cloud@work",
              },
            },
          },
        },
      },
      env: process.env,
      entries: [],
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "global-fallback:cloud",
    );
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "per-agent:cloud",
    );
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "heartbeat:cloud",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "global-fallback:cloud",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
      expect.objectContaining({
        provider: "ollama",
        id: "heartbeat:cloud",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
      expect.objectContaining({
        provider: "ollama",
        id: "per-agent:cloud",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
    ]);
  });

  it("augments configured Ollama Cloud refs with resolved auth", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/cloud-new:cloud": {},
            },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              api: "ollama",
            },
          },
        },
      },
      env: {},
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "cloud-key" })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-key" },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "cloud-new:cloud",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
    ]);
  });

  it("augments configured remote Ollama refs with configured auth", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/remote-new": {},
            },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.example.test",
              api: "ollama",
              apiKey: "remote-key",
            },
          },
        },
      },
      env: {},
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "" })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.example.test",
      "remote-new",
      { apiKey: "remote-key" },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "remote-new",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
    ]);
  });

  it.each(["$OLLAMA_API_KEY", "${OLLAMA_API_KEY}"])(
    "resolves configured Ollama Cloud SecretInput auth string %s",
    async (apiKeyRef) => {
      const provider = registerProvider();
      queryOllamaModelShowInfoMock.mockResolvedValueOnce({
        contextWindow: 1_048_576,
        capabilities: ["completion", "thinking"],
      });

      await provider.augmentModelCatalog?.({
        config: {
          agents: {
            defaults: {
              models: {
                "ollama/cloud-new:cloud": {},
              },
            },
          },
          models: {
            providers: {
              ollama: {
                baseUrl: "https://ollama.com",
                api: "ollama",
                apiKey: apiKeyRef,
              },
            },
          },
        },
        env: { OLLAMA_API_KEY: "cloud-key" },
        entries: [],
        resolveProviderApiKey: vi.fn(() => ({
          apiKey: "OLLAMA_API_KEY",
          discoveryApiKey: "cloud-key",
        })),
      } as never);

      expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
        "https://ollama.com",
        "cloud-new:cloud",
        { apiKey: "cloud-key" },
      );
      queryOllamaModelShowInfoMock.mockClear();
    },
  );

  it("augments secured local Ollama refs with resolved configured auth", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking"],
    });

    await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/local-secured": {},
            },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              apiKey: { source: "env", provider: "default", id: "LOCAL_OLLAMA_API_KEY" },
            },
          },
        },
      },
      env: {
        LOCAL_OLLAMA_API_KEY: "local-key",
        OLLAMA_API_KEY: "ambient-cloud-key",
      },
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "LOCAL_OLLAMA_API_KEY",
        discoveryApiKey: "local-key",
      })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "local-secured",
      { apiKey: "local-key" },
    );
  });

  it("does not attach ambient OLLAMA_API_KEY to local show probes", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools"],
    });

    await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/local-open": {},
            },
          },
        },
      },
      env: {
        OLLAMA_API_KEY: "ambient-cloud-key",
      },
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "OLLAMA_API_KEY",
        discoveryApiKey: "ambient-cloud-key",
      })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "local-open",
    );
  });

  it("augments configured first-class Ollama Cloud provider refs", async () => {
    const provider = registerOllamaCloudProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama-cloud/cloud-new:cloud": {},
            },
          },
        },
      },
      env: {},
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "cloud-key" })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-key" },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama-cloud",
        id: "cloud-new:cloud",
        reasoning: true,
        contextWindow: 1_048_576,
      }),
    ]);
  });

  it("prefers explicit Ollama Cloud provider keys over local env markers", async () => {
    const provider = registerOllamaCloudProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama-cloud/cloud-new:cloud": {},
            },
          },
        },
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              api: "ollama",
              apiKey: "cloud-config-key",
            },
          },
        },
      },
      env: { OLLAMA_API_KEY: "ollama-local" },
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "ollama-local" })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-config-key" },
    );
  });

  it("uses resolved discovery auth instead of non-secret markers for Ollama Cloud probes", async () => {
    const provider = registerOllamaCloudProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama-cloud/cloud-new:cloud": {},
            },
          },
        },
      },
      env: {},
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "secretref-managed", // pragma: allowlist secret
        discoveryApiKey: "cloud-key",
      })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-key" },
    );
  });

  it("does not probe Ollama Cloud catalog with non-secret auth markers", async () => {
    const provider = registerOllamaCloudProvider();

    const rows = await provider.augmentModelCatalog?.({
      config: {
        agents: {
          defaults: {
            models: {
              "ollama-cloud/cloud-new:cloud": {},
            },
          },
        },
      },
      env: { OLLAMA_API_KEY: "secretref-managed" }, // pragma: allowlist secret
      entries: [],
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "secretref-managed", // pragma: allowlist secret
      })),
    } as never);

    expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("augments id-only configured Ollama provider rows with live show capabilities", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking", "vision"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {},
      env: process.env,
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "Configured Minimax M3",
          api: "openai-completions",
        },
      ],
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "minimax-m3:cloud",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        name: "Configured Minimax M3",
        api: "openai-completions",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        compat: {
          supportsTools: true,
          supportsUsageInStreaming: true,
        },
      }),
    ]);
  });

  it("fills missing metadata on partially configured Ollama provider rows", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking", "vision"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {},
      env: process.env,
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "minimax-m3:cloud",
          contextWindow: 128_000,
        },
      ],
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "minimax-m3:cloud",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        reasoning: true,
        input: ["text", "image"],
        compat: {
          supportsTools: true,
          supportsUsageInStreaming: true,
        },
      }),
    ]);
  });

  it("does not override configured Ollama provider metadata", async () => {
    const provider = registerProvider();

    const rows = await provider.augmentModelCatalog?.({
      config: {},
      env: process.env,
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "minimax-m3:cloud",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
          compat: { supportsTools: false },
        },
      ],
    } as never);

    expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("bounds configured Ollama show probes", async () => {
    const provider = registerProvider();
    let active = 0;
    let maxActive = 0;
    queryOllamaModelShowInfoMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      active -= 1;
      return {
        contextWindow: 1_048_576,
        capabilities: ["completion", "thinking"],
      };
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {},
      env: process.env,
      entries: Array.from({ length: 5 }, (_, index) => ({
        provider: "ollama",
        id: `model-${index}:cloud`,
        name: `model-${index}:cloud`,
      })),
    } as never);

    expect(rows).toHaveLength(5);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("caps configured Ollama show probes", async () => {
    const provider = registerProvider();
    queryOllamaModelShowInfoMock.mockResolvedValue({
      contextWindow: 1_048_576,
      capabilities: ["completion", "thinking"],
    });

    const rows = await provider.augmentModelCatalog?.({
      config: {},
      env: process.env,
      entries: Array.from({ length: 10 }, (_, index) => ({
        provider: "ollama",
        id: `model-${index}:cloud`,
        name: `model-${index}:cloud`,
      })),
    } as never);

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledTimes(8);
    expect(rows).toHaveLength(8);
  });

  it("keeps unknown requested Ollama models unresolved when show has no metadata", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-local";
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({});

    try {
      await provider.prepareDynamicModel?.({
        config: {},
        provider: "ollama",
        modelId: "depseek-v4-pro:cloud",
        modelRegistry: { find: vi.fn(() => null) },
      } as never);

      expect(
        provider.resolveDynamicModel?.({
          config: {},
          provider: "ollama",
          modelId: "depseek-v4-pro:cloud",
          modelRegistry: { find: vi.fn(() => null) },
        } as never),
      ).toBeUndefined();
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

    const result = await provider.catalog.run({
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

  it.each(["docker.orb.internal", "host.docker.internal", "host.orb.internal"])(
    "skips implicit localhost discovery when a custom host-backed Ollama provider is configured for %s",
    async (hostname) => {
      const provider = registerProvider();

      const result = await provider.catalog.run({
        config: {
          models: {
            providers: {
              "ollama-orb": {
                api: "ollama",
                baseUrl: `http://${hostname}:11434`,
                models: [{ id: "qwen3.5:27b", name: "Qwen 3.5 27B" }],
              },
            },
          },
        },
        env: { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-live" }),
      } as never);

      expect(result).toBeNull();
      expect(buildOllamaProviderMock).not.toHaveBeenCalled();
    },
  );

  it("treats custom 127/8 Ollama providers as loopback for implicit discovery", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      models: [],
    });

    const result = await provider.catalog.run({
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

    const resultProvider = requireRecord(result?.provider, "catalog provider");
    expect(resultProvider.baseUrl).toBe("http://127.0.0.1:11434");
    expect(resultProvider.api).toBe("ollama");
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

  it("registers ollama-cloud as a hosted provider", async () => {
    const provider = registerOllamaCloudProvider();

    expect(provider.id).toBe("ollama-cloud");
    expect(provider.envVars).toEqual(["OLLAMA_API_KEY"]);
    expect(provider.auth?.map((method: { id: string }) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    if (!result || !("provider" in result)) {
      throw new Error("single provider catalog result missing");
    }
    expect(result.provider.baseUrl).toBe("https://ollama.com");
    expect(result.provider.models?.map((model: { id: string }) => model.id)).toEqual([
      "kimi-k2.5:cloud",
      "minimax-m2.7:cloud",
      "glm-5.1:cloud",
      "glm-5.2:cloud",
    ]);

    provider.createStreamFn?.({
      config: {},
      model: { api: "ollama", id: "kimi-k2.5:cloud" },
      provider: "ollama-cloud",
    } as never);
    expect(requireConfiguredStreamParams().providerBaseUrl).toBe("https://ollama.com");
  });

  it("uses Ollama Cloud auth for live catalog discovery", async () => {
    const provider = registerOllamaCloudProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [buildOllamaModelDefinitionMock("glm-5.2:cloud")],
    });

    const result = await provider.catalog.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "OLLAMA_API_KEY",
        discoveryApiKey: "cloud-key",
      }),
    } as never);

    expect(buildOllamaProviderMock).toHaveBeenCalledWith("https://ollama.com", {
      apiKey: "cloud-key",
      quiet: true,
    });
    expect(result?.provider.apiKey).toBe("OLLAMA_API_KEY");
    expect(result?.provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "glm-5.2:cloud", name: "glm-5.2:cloud" }),
      ]),
    );
  });

  it("confirms GLM-5.2 with authenticated show when cloud tags omit it", async () => {
    const provider = registerOllamaCloudProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [buildOllamaModelDefinitionMock("kimi-k2.5:cloud")],
    });
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({
      contextWindow: 1_000_000,
      capabilities: ["completion", "thinking", "tools"],
    });
    const result = await provider.catalog.run({
      config: {
        agents: { defaults: { model: { primary: "ollama-cloud/glm-5.2:cloud" } } },
      },
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: "cloud-key",
      }),
    } as never);

    expect(buildOllamaProviderMock).toHaveBeenCalledWith("https://ollama.com", {
      apiKey: "cloud-key",
      quiet: true,
    });
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "glm-5.2:cloud",
      { apiKey: "cloud-key" },
    );
    expect(result?.provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "glm-5.2:cloud",
          contextWindow: 1_000_000,
          maxTokens: 8192,
          reasoning: true,
        }),
      ]),
    );
  });

  it("resolves GLM-5.2 from the cloud fallback catalog", () => {
    const provider = registerOllamaCloudProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "ollama-cloud",
      modelId: "glm-5.2:cloud",
    } as never);

    expect(model).toEqual(
      expect.objectContaining({
        provider: "ollama-cloud",
        id: "glm-5.2:cloud",
        contextWindow: 1_000_000,
        maxTokens: 8192,
        reasoning: true,
      }),
    );
    expect(model?.contextTokens).toBeUndefined();
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
        contextTokens: 32_768,
      },
      streamFn: baseStreamFn,
    });

    if (!wrapped) {
      throw new Error("expected Ollama OpenAI-compatible stream wrapper");
    }
    void wrapped({} as never, {} as never, {});
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(32_768);
  });

  it("owns replay policy for OpenAI-compatible and native Ollama routes", () => {
    const provider = registerProvider();

    const openAiCompatPolicy = provider.buildReplayPolicy?.({
      provider: "ollama",
      modelApi: "openai-completions",
      modelId: "qwen3:32b",
    } as never);
    expect(openAiCompatPolicy?.sanitizeToolCallIds).toBe(true);
    expect(openAiCompatPolicy?.toolCallIdMode).toBe("strict");
    expect(openAiCompatPolicy?.applyAssistantFirstOrderingFix).toBe(true);
    expect(openAiCompatPolicy?.validateGeminiTurns).toBe(true);
    expect(openAiCompatPolicy?.validateAnthropicTurns).toBe(true);

    const responsesPolicy = provider.buildReplayPolicy?.({
      provider: "ollama",
      modelApi: "openai-responses",
      modelId: "qwen3:32b",
    } as never);
    expect(responsesPolicy?.sanitizeToolCallIds).toBe(true);
    expect(responsesPolicy?.toolCallIdMode).toBe("strict");
    expect(responsesPolicy?.applyAssistantFirstOrderingFix).toBe(false);
    expect(responsesPolicy?.validateGeminiTurns).toBe(false);
    expect(responsesPolicy?.validateAnthropicTurns).toBe(false);

    const nativePolicy = provider.buildReplayPolicy?.({
      provider: "ollama",
      modelApi: "ollama",
      modelId: "qwen3.5:9b",
    } as never);
    expect(nativePolicy?.sanitizeToolCallIds).toBe(false);
    expect(nativePolicy?.toolCallIdMode).toBeUndefined();
    expect(nativePolicy?.applyAssistantFirstOrderingFix).toBe(true);
    expect(nativePolicy?.validateGeminiTurns).toBe(true);
    expect(nativePolicy?.validateAnthropicTurns).toBe(true);
  });

  it.each([
    {
      providerId: "ollama",
      register: registerProvider,
      nativeBaseUrl: "http://127.0.0.1:11434",
    },
    {
      providerId: "ollama-cloud",
      register: registerOllamaCloudProvider,
      nativeBaseUrl: "https://ollama.com",
    },
  ])(
    "$providerId selects native /api/chat transport only for api=ollama",
    ({ providerId, register, nativeBaseUrl }) => {
      const provider = register();
      const createStream = (api: "ollama" | "openai-completions", baseUrl: string) =>
        provider.createStreamFn?.({
          config: {
            models: {
              providers: {
                [providerId]: {
                  api,
                  baseUrl,
                  models: [],
                },
              },
            },
          },
          model: {
            api,
            id: "qwen3:32b",
            provider: providerId,
          },
          provider: providerId,
        } as never);

      const compatibleStream = createStream("openai-completions", `${nativeBaseUrl}/v1`);

      expect(compatibleStream).toBeUndefined();
      expect(createConfiguredOllamaStreamFnMock).not.toHaveBeenCalled();

      const nativeStream = createStream("ollama", nativeBaseUrl);

      expect(nativeStream).toBeDefined();
      expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledOnce();
      expect(requireConfiguredStreamParams().providerBaseUrl).toBe(nativeBaseUrl);
    },
  );

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
    const model = { id: "llama3.2", provider: "ollama2", api: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(requireConfiguredStreamParams().providerBaseUrl).toBe("http://127.0.0.1:11435");
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
    const model = { id: "llama3.2", provider: "ollama2", api: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(requireConfiguredStreamParams().providerBaseUrl).toBe("http://127.0.0.1:11435");
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
    const model = { id: "llama3.2", provider: "ollama", api: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: "ollama" } as never);

    expect(requireConfiguredStreamParams().providerBaseUrl).toBe("http://127.0.0.1:11434");
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
    const ollamaMedia = expectDefined(mediaProviders[0], "Ollama media provider");
    expect(ollamaMedia.id).toBe("ollama");
    expect(ollamaMedia.capabilities).toEqual(["image"]);
    expect(ollamaMedia.describeImage).toBe(describeImageWithModel);
    expect(ollamaMedia.describeImages).toBe(describeImagesWithModel);
    // Intentional: no defaultModels or autoPriority. Ollama vision models are
    // user-installed (llava, qwen2.5vl, …) with no universal default, and we
    // don't want Ollama to auto-steal image duty from configured providers.
    expect(ollamaMedia.defaultModels).toBeUndefined();
    expect(ollamaMedia.autoPriority).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
