import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { addModelToConfig, listAddableProviders, validateAddProvider } from "./models-add.js";

const configMocks = vi.hoisted(() => ({
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
    readonly currentHash: string | null;

    constructor(message: string, params: { currentHash: string | null }) {
      super(message);
      this.name = "ConfigMutationConflictError";
      this.currentHash = params.currentHash;
    }
  },
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
}));

const facadeRuntimeMocks = vi.hoisted(() => ({
  loadBundledPluginPublicSurfaceModuleSync: vi.fn(),
}));

const ollamaMocks = vi.hoisted(() => ({
  buildOllamaModelDefinition: vi.fn(
    (modelId: string, contextWindow?: number, capabilities?: string[]) => ({
      id: modelId,
      name: modelId,
      reasoning: /think|reason/i.test(modelId),
      input: capabilities?.includes("vision") ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow ?? 32768,
      maxTokens: 8192,
    }),
  ),
  queryOllamaModelShowInfo: vi.fn(),
}));

const lmstudioRuntimeMocks = vi.hoisted(() => ({
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: "LMSTUDIO_API_KEY",
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: "http://127.0.0.1:1234/v1",
  fetchLmstudioModels: vi.fn(),
  mapLmstudioWireEntry: vi.fn(
    (entry: {
      key: string;
      displayName?: string;
      display_name?: string;
      max_context_length?: number;
      capabilities?: { reasoning?: { allowed_options?: string[] } };
    }) => ({
      id: entry.key,
      displayName: entry.displayName ?? entry.display_name ?? entry.key,
      reasoning: (entry.capabilities?.reasoning?.allowed_options?.length ?? 0) > 0,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.max_context_length ?? 32768,
      maxTokens: 8192,
    }),
  ),
  resolveLmstudioInferenceBase: vi.fn((baseUrl?: string) => baseUrl ?? "http://127.0.0.1:1234/v1"),
  resolveLmstudioRequestContext: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  ConfigMutationConflictError: configMocks.ConfigMutationConflictError,
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  replaceConfigFile: configMocks.replaceConfigFile,
  validateConfigObjectWithPlugins: configMocks.validateConfigObjectWithPlugins,
}));

vi.mock("../../plugin-sdk/facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/facade-runtime.js")>(
    "../../plugin-sdk/facade-runtime.js",
  );
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync:
      facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync,
  };
});

vi.mock("../../plugin-sdk/lmstudio-runtime.js", () => {
  return {
    LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: lmstudioRuntimeMocks.LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: lmstudioRuntimeMocks.LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
    fetchLmstudioModels: lmstudioRuntimeMocks.fetchLmstudioModels,
    mapLmstudioWireEntry: lmstudioRuntimeMocks.mapLmstudioWireEntry,
    resolveLmstudioInferenceBase: lmstudioRuntimeMocks.resolveLmstudioInferenceBase,
    resolveLmstudioRequestContext: lmstudioRuntimeMocks.resolveLmstudioRequestContext,
  };
});

describe("models-add", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.replaceConfigFile.mockReset();
    configMocks.validateConfigObjectWithPlugins.mockReset();
    facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync.mockReset();
    facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync.mockImplementation((params) => {
      if (
        params &&
        typeof params === "object" &&
        "dirName" in params &&
        params.dirName === "ollama" &&
        "artifactBasename" in params &&
        params.artifactBasename === "api.js"
      ) {
        return {
          buildOllamaModelDefinition: ollamaMocks.buildOllamaModelDefinition,
          queryOllamaModelShowInfo: ollamaMocks.queryOllamaModelShowInfo,
        };
      }
      if (
        params &&
        typeof params === "object" &&
        "dirName" in params &&
        params.dirName === "openai" &&
        "artifactBasename" in params &&
        params.artifactBasename === "api.js"
      ) {
        return {
          buildOpenAICodexProvider: () => ({
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [],
          }),
          buildOpenAICodexProviderPlugin: () => ({
            resolveDynamicModel: ({ modelId }: { modelId: string }) => {
              const common = {
                id: modelId,
                name: modelId,
                api: "openai-codex-responses",
                provider: "openai-codex",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                reasoning: true,
                input: ["text", "image"],
                contextTokens: 272_000,
                maxTokens: 128_000,
              } as const;
              switch (modelId) {
                case "gpt-5.4":
                  return {
                    ...common,
                    contextWindow: 1_050_000,
                    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
                  };
                case "gpt-5.5":
                  return {
                    ...common,
                    contextWindow: 1_000_000,
                    cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
                  };
                case "gpt-5.5-pro":
                  return {
                    ...common,
                    contextWindow: 1_000_000,
                    cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
                  };
                default:
                  return undefined;
              }
            },
          }),
        };
      }
      throw new Error(`Unexpected facade load: ${JSON.stringify(params)}`);
    });
    ollamaMocks.buildOllamaModelDefinition.mockClear();
    ollamaMocks.queryOllamaModelShowInfo.mockReset();
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({});
    lmstudioRuntimeMocks.fetchLmstudioModels.mockReset();
    lmstudioRuntimeMocks.mapLmstudioWireEntry.mockClear();
    lmstudioRuntimeMocks.resolveLmstudioInferenceBase.mockClear();
    lmstudioRuntimeMocks.resolveLmstudioRequestContext.mockReset();
  });

  it("lists addable providers only when the write path can actually add them", () => {
    const cfg = {
      models: {
        providers: {
          lmstudio: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", models: [] },
        },
      },
    } as OpenClawConfig;
    expect(
      listAddableProviders({
        cfg,
        discoveredProviders: ["openai", "openai-codex", "ollama"],
      }),
    ).toEqual(["lmstudio", "ollama", "openai-codex"]);
  });

  it("validates add providers against addable providers", () => {
    const cfg = {} as OpenClawConfig;
    expect(validateAddProvider({ cfg, provider: "ollama", discoveredProviders: [] })).toEqual({
      ok: true,
      provider: "ollama",
    });
    expect(validateAddProvider({ cfg, provider: "missing", discoveredProviders: [] })).toEqual({
      ok: false,
      providers: ["lmstudio", "ollama"],
    });
  });

  it("only bootstraps openai-codex when the provider is discovered", () => {
    const cfg = {} as OpenClawConfig;

    expect(validateAddProvider({ cfg, provider: "openai-codex", discoveredProviders: [] })).toEqual(
      {
        ok: false,
        providers: ["lmstudio", "ollama"],
      },
    );
    expect(
      validateAddProvider({
        cfg,
        provider: "openai-codex",
        discoveredProviders: ["openai-codex"],
      }),
    ).toEqual({
      ok: true,
      provider: "openai-codex",
    });
  });

  it("rejects discovered providers that are not configured for custom models", () => {
    const cfg = {} as OpenClawConfig;

    expect(
      validateAddProvider({
        cfg,
        provider: "openai",
        discoveredProviders: ["openai"],
      }),
    ).toEqual({
      ok: false,
      providers: ["lmstudio", "ollama"],
      knownProvider: "openai",
    });
  });

  it("adds an ollama model and extends the allowlist when needed", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {},
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({
      contextWindow: 202752,
      capabilities: ["thinking", "tools"],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.result.existed).toBe(false);
    expect(result.result.allowlistAdded).toBe(true);
    expect(configMocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const written = configMocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig as OpenClawConfig;
    expect(written.models?.providers?.ollama?.models).toEqual([
      expect.objectContaining({
        id: "glm-5.1:cloud",
        reasoning: false,
        contextWindow: 202752,
      }),
    ]);
    expect(written.agents?.defaults?.models?.["ollama/glm-5.1:cloud"]).toEqual({});
  });

  it("reuses an existing configured provider key when the stored key is non-canonical", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {},
          },
        },
      },
      models: {
        providers: {
          Ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({
      contextWindow: 202752,
      capabilities: ["thinking"],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const written = configMocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig as OpenClawConfig;
    expect(written.models?.providers?.Ollama?.models).toEqual([
      expect.objectContaining({
        id: "glm-5.1:cloud",
      }),
    ]);
    expect(written.models?.providers?.ollama).toBeUndefined();
  });

  it("treats duplicate provider/model entries as idempotent", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [
              {
                id: "glm-5.1:cloud",
                name: "glm-5.1:cloud",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 202752,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result).toEqual({
      ok: true,
      result: {
        provider: "ollama",
        modelId: "glm-5.1:cloud",
        existed: true,
        allowlistAdded: false,
        warnings: ["Model metadata could not be auto-detected; saved with default capabilities."],
      },
    });
    expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("bootstraps lmstudio provider config when missing", async () => {
    const cfg = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
      models: { providers: {} },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    lmstudioRuntimeMocks.resolveLmstudioRequestContext.mockResolvedValue({
      apiKey: undefined,
      headers: undefined,
    });
    lmstudioRuntimeMocks.fetchLmstudioModels.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "qwen/qwen3.5-9b",
          display_name: "Qwen 3.5 9B",
          max_context_length: 131072,
          capabilities: { reasoning: { allowed_options: ["off", "on"] } },
        },
      ],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "lmstudio",
      modelId: "qwen/qwen3.5-9b",
    });

    expect(result.ok).toBe(true);
    const written = configMocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig as OpenClawConfig;
    expect(written.models?.providers?.lmstudio?.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(written.models?.providers?.lmstudio?.api).toBe("openai-completions");
    expect(written.models?.providers?.lmstudio?.models).toEqual([
      expect.objectContaining({
        id: "qwen/qwen3.5-9b",
        name: "Qwen 3.5 9B",
      }),
    ]);
  });

  it.each([
    [
      "gpt-5.4",
      {
        contextWindow: 1_050_000,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      },
    ],
    [
      "gpt-5.5",
      {
        contextWindow: 1_000_000,
        cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    [
      "gpt-5.5-pro",
      {
        contextWindow: 1_000_000,
        cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])(
    "bootstraps openai-codex metadata for %s from the provider plugin",
    async (modelId, expected) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.4" },
            models: {
              "openai-codex/gpt-5.3": {},
            },
          },
        },
        models: { providers: {} },
      } as OpenClawConfig;
      configMocks.readConfigFileSnapshot.mockResolvedValue({
        valid: true,
        parsed: cfg,
      });
      configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
        ok: true,
        config,
      }));

      const result = await addModelToConfig({
        cfg,
        provider: "openai-codex",
        modelId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.result.allowlistAdded).toBe(true);
      expect(result.result.warnings).toEqual([
        "OpenAI Codex model metadata was saved from provider defaults; provider availability still depends on your Codex account.",
      ]);
      const written = configMocks.replaceConfigFile.mock.calls[0]?.[0]
        ?.nextConfig as OpenClawConfig;
      expect(written.models?.providers?.["openai-codex"]).toMatchObject({
        baseUrl: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        models: [
          expect.objectContaining({
            id: modelId,
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: expected.contextWindow,
            contextTokens: 272_000,
            maxTokens: 128_000,
            cost: expected.cost,
            metadataSource: "models-add",
          }),
        ],
      });
      expect(written.agents?.defaults?.models?.[`openai-codex/${modelId}`]).toEqual({});
    },
  );

  it("returns a generic validation error when config validation fails without issue details", async () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({
      contextWindow: 202752,
      capabilities: ["thinking"],
    });
    configMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      issues: [],
    });

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result).toEqual({
      ok: false,
      error: "Config invalid after /models add (unknown validation error).",
    });
  });

  it("skips lmstudio metadata detection for non-loopback base urls before resolving auth", async () => {
    const cfg = {
      models: {
        providers: {
          lmstudio: {
            baseUrl: "https://example.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "lmstudio",
      modelId: "qwen/qwen3.5-9b",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(lmstudioRuntimeMocks.resolveLmstudioRequestContext).not.toHaveBeenCalled();
    expect(lmstudioRuntimeMocks.fetchLmstudioModels).not.toHaveBeenCalled();
    expect(result.result.warnings).toContain(
      "LM Studio metadata detection is limited to local baseUrl values; using defaults.",
    );
  });

  it("does not leak raw lmstudio detection errors in user-facing warnings", async () => {
    const cfg = {
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://localhost:1234/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    lmstudioRuntimeMocks.resolveLmstudioRequestContext.mockResolvedValue({
      apiKey: "secret-token",
      headers: { Authorization: "Bearer secret-token" },
    });
    lmstudioRuntimeMocks.fetchLmstudioModels.mockRejectedValue(
      new Error("connect ECONNREFUSED http://127.0.0.1:1234/v1/api/v1/models"),
    );
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "lmstudio",
      modelId: "qwen/qwen3.5-9b",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.result.warnings).toContain(
      "LM Studio metadata detection failed; using defaults.",
    );
    expect(result.result.warnings.join(" ")).not.toContain("ECONNREFUSED");
    expect(result.result.warnings.join(" ")).not.toContain("127.0.0.1");
  });

  it("returns a retryable error when the config changes before replace", async () => {
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
      hash: "base-hash",
    });
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({
      contextWindow: 202752,
      capabilities: ["thinking"],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));
    configMocks.replaceConfigFile.mockRejectedValue(
      new configMocks.ConfigMutationConflictError("config changed since last load", {
        currentHash: "new-hash",
      }),
    );

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result).toEqual({
      ok: false,
      error: "Config changed while /models add was running. Retry the command.",
    });
  });
});
