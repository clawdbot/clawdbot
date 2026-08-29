import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  capturePluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
// Ollama tests cover index plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { OLLAMA_DEFAULT_API_KEY } from "./src/discovery-shared.js";

const promptAndConfigureOllamaMock = vi.hoisted(() =>
  vi.fn(async () => ({
    defaultModel: "ollama/qwen-tool",
    config: {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: [{ id: "qwen-tool", name: "qwen-tool" }],
          },
        },
      },
    },
  })),
);
const ensureOllamaModelPulledMock = vi.hoisted(() => vi.fn(async () => {}));
const configureOllamaNonInteractiveMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const fetchOllamaModelsMock = vi.hoisted(() => vi.fn());
const fetchLoadedOllamaModelNamesMock = vi.hoisted(() => vi.fn());
const buildOllamaProviderMock = vi.hoisted(() => vi.fn());
const queryOllamaModelShowInfoMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputStringMock = vi.hoisted(() => vi.fn());
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
  vi.fn((_params: { model: unknown; providerBaseUrl?: string }) => (() => ({})) as never),
);

vi.mock("./src/provider-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/provider-models.js")>()),
  buildOllamaModelDefinition: buildOllamaModelDefinitionMock,
  buildOllamaProvider: buildOllamaProviderMock,
  fetchOllamaModels: fetchOllamaModelsMock,
  fetchLoadedOllamaModelNames: fetchLoadedOllamaModelNamesMock,
  queryOllamaModelShowInfo: queryOllamaModelShowInfoMock,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/secret-input-runtime")>();
  return {
    ...actual,
    resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock.mockImplementation(
      actual.resolveConfiguredSecretInputString,
    ),
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("./src/setup.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/setup.runtime.js")>()),
  configureOllamaNonInteractive: configureOllamaNonInteractiveMock,
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
}));

vi.mock("./src/stream-registration.js", () => ({
  createLazyConfiguredOllamaStreamFn: createConfiguredOllamaStreamFnMock,
}));

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  fetchWithSsrFGuardMock.mockReset();
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(null, { status: 200 }),
    release: vi.fn(async () => {}),
  });
  configureOllamaNonInteractiveMock.mockReset();
  fetchOllamaModelsMock.mockReset();
  fetchLoadedOllamaModelNamesMock.mockReset();
  fetchLoadedOllamaModelNamesMock.mockResolvedValue({
    reachable: true,
    models: ["qwen-tool", "qwen3.5:4b", "llama3.3:70b", "nomic-embed-text", "unknown-tools"],
  });
  buildOllamaProviderMock.mockReset();
  queryOllamaModelShowInfoMock.mockReset();
  resolveConfiguredSecretInputStringMock.mockClear();
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
      runtime: createPluginRuntimeMock(),
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

describe("ollama tool-schema compatibility", () => {
  it("registers local and cloud providers without accessing the inactive LLM runtime", () => {
    const captured = capturePluginRegistration(plugin);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["ollama-cloud", "ollama"]);
  });

  it("registers llama.cpp GBNF projection for local and cloud providers", () => {
    for (const provider of registerProvidersWithPluginConfig({})) {
      expect(provider).toMatchObject({
        normalizeToolSchemas: expect.any(Function),
        inspectToolSchemas: expect.any(Function),
      });
    }
  });

  it("keeps configured-row projection aligned with absent runtime model normalizers", () => {
    for (const provider of registerProvidersWithPluginConfig({})) {
      expect(provider.normalizeResolvedModel).toBeUndefined();
    }
  });
});

function createOllamaResetValidationContext(
  opts: Record<string, unknown> = {},
): Parameters<NonNullable<ProviderAuthMethod["validateNonInteractive"]>>[0] {
  return {
    authChoice: "ollama",
    config: {},
    baseConfig: {},
    opts,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
    },
    resolveApiKey: vi.fn(async () => null),
  };
}

const requireRecord = createRequireRecord("object", "expected-label");

function requireConfiguredStreamParams(): Record<string, unknown> {
  return requireRecord(createConfiguredOllamaStreamFnMock.mock.calls[0]?.[0], "stream params");
}

function mockDiscoveredOllamaProvider(
  models: Array<Record<string, unknown>>,
  options: { baseUrl?: string; once?: boolean } = {},
) {
  const provider = {
    baseUrl: options.baseUrl ?? "http://127.0.0.1:11434",
    api: "ollama",
    models,
  };
  if (options.once) {
    buildOllamaProviderMock.mockResolvedValueOnce(provider);
  } else {
    buildOllamaProviderMock.mockResolvedValue(provider);
  }
}

function mockOllamaShowInfo(
  capabilities: string[],
  options: { contextWindow?: number; once?: boolean } = {},
) {
  const info = {
    contextWindow: options.contextWindow ?? 1_048_576,
    capabilities,
  };
  if (options.once === false) {
    queryOllamaModelShowInfoMock.mockResolvedValue(info);
  } else {
    queryOllamaModelShowInfoMock.mockResolvedValueOnce(info);
  }
}

function createDynamicModelContext(modelId: string, config: Record<string, unknown> = {}) {
  return {
    config,
    provider: "ollama",
    modelId,
    modelRegistry: { find: vi.fn(() => null) },
  };
}

async function augmentOllamaCatalog(
  provider: ReturnType<typeof registerProvider>,
  overrides: Record<string, unknown> = {},
) {
  return await provider.augmentModelCatalog?.({
    config: {},
    env: process.env,
    entries: [],
    ...overrides,
  } as never);
}

function captureWrappedOllamaPayload(
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "max" | undefined,
  route: { provider?: string; modelId?: string; baseUrl?: string } = {},
) {
  const provider = registerProvider();
  const providerId = route.provider ?? "ollama";
  const modelId = route.modelId ?? "qwen3.5:9b";
  const baseUrl = route.baseUrl ?? "http://127.0.0.1:11434";
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
          [providerId]: {
            api: "ollama",
            baseUrl,
            models: [],
          },
        },
      },
    },
    provider: providerId,
    modelId,
    thinkingLevel,
    model: {
      api: "ollama",
      provider: providerId,
      id: modelId,
      baseUrl,
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
      provider: providerId,
      id: modelId,
    } as never,
    {} as never,
    {},
  );
  return { baseStreamFn, payloadSeen };
}

describe("ollama plugin", () => {
  it.each([
    {
      name: "preflights an available local model before destructive non-interactive reset",
      models: ["gemma4"],
      customBaseUrl: "http://ollama-host:11434/",
      customModelId: "gemma4",
    },
    {
      name: "rejects an unreachable Ollama endpoint before destructive reset",
      reachable: false,
      models: [],
      error:
        "Ollama could not be reached at http://ollama-host:11434.\nDownload it at https://ollama.com/download",
    },
    {
      name: "rejects a missing requested Ollama model even when another model is available",
      models: ["qwen2.5-coder:7b"],
      customModelId: "gemma4",
      error:
        "Ollama model gemma4 was not found at http://ollama-host:11434.\nAvailable models: qwen2.5-coder:7b",
    },
    {
      name: "recognizes the implicit latest tag without pulling during reset preflight",
      models: ["gemma4:latest"],
      customModelId: "ollama/gemma4",
    },
    {
      name: "preflights the canonical default Ollama model without pulling it",
      models: ["gemma4:latest"],
    },
    {
      name: "accepts an installed Ollama model when the suggested default is unavailable",
      models: ["qwen2.5-coder:7b"],
    },
    {
      name: "refuses to pull an unavailable local model during destructive-reset preflight",
      models: [],
      customModelId: "gemma4",
      error:
        "No Ollama models are available at http://ollama-host:11434.\nPull a model first, then re-run setup.",
    },
    {
      name: "preflights an authenticated and confirmed cloud model without pulling it",
      models: [],
      customModelId: "ollama/kimi-k2.5:cloud",
      cloud: "confirmed",
    },
    {
      name: "rejects an unauthenticated Ollama cloud model before destructive reset",
      models: [],
      customModelId: "kimi-k2.5:cloud",
      cloud: "unauthenticated",
      error: "Cloud models on this Ollama host need `ollama signin`.\nhttps://ollama.com/signin",
    },
    {
      name: "rejects an unconfirmed Ollama cloud model before destructive reset",
      models: [],
      customModelId: "kimi-k2.5:cloud",
      cloud: "unconfirmed",
      error:
        "Ollama model kimi-k2.5:cloud was not found at http://ollama-host:11434.\nAvailable models: (none)",
    },
    {
      name: "confirms a catalog-listed Ollama cloud model before destructive reset",
      models: ["kimi-k2.5:cloud"],
      customModelId: "kimi-k2.5:cloud",
      cloud: "confirmed",
    },
    {
      name: "rejects a stale catalog-listed Ollama cloud model before destructive reset",
      models: ["kimi-k2.5:cloud"],
      customModelId: "kimi-k2.5:cloud",
      cloud: "unconfirmed",
      error:
        "Ollama model kimi-k2.5:cloud was not found at http://ollama-host:11434.\nAvailable models: kimi-k2.5:cloud",
    },
  ] as Array<{
    name: string;
    models: string[];
    reachable?: boolean;
    customBaseUrl?: string;
    customModelId?: string;
    cloud?: "confirmed" | "unauthenticated" | "unconfirmed";
    error?: string;
  }>)("$name", async ({ models, reachable = true, customBaseUrl, customModelId, cloud, error }) => {
    fetchOllamaModelsMock.mockResolvedValue({
      reachable,
      models: models.map((name) => ({ name })),
    });
    if (cloud === "unauthenticated") {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(JSON.stringify({ signin_url: "https://ollama.com/signin" }), {
          status: 401,
        }),
        release: vi.fn(async () => {}),
      });
    }
    if (cloud === "unconfirmed") {
      queryOllamaModelShowInfoMock.mockResolvedValue({});
    }

    const ctx = createOllamaResetValidationContext({
      customBaseUrl: customBaseUrl ?? "http://ollama-host:11434",
      ...(customModelId ? { customModelId } : {}),
    });
    const validate = registerProvider().auth[0].validateNonInteractive;
    expect(validate).toBeTypeOf("function");
    await expect(validate(ctx)).resolves.toBe(!error);

    if (customBaseUrl?.endsWith("/")) {
      expect(fetchOllamaModelsMock).toHaveBeenCalledWith("http://ollama-host:11434");
    }
    if (cloud === "confirmed") {
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://ollama-host:11434/api/me" }),
      );
      expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
        "http://ollama-host:11434",
        "kimi-k2.5:cloud",
      );
    }
    if (cloud === "unauthenticated") {
      expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
    }
    if (error) {
      expect(ctx.runtime.error).toHaveBeenCalledWith(error);
      expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(ctx.runtime.exit).not.toHaveBeenCalled();
    }
    expect(configureOllamaNonInteractiveMock).not.toHaveBeenCalled();
    expect(ensureOllamaModelPulledMock).not.toHaveBeenCalled();
  });

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
        runtime: createPluginRuntimeMock(),
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
        runtime: createPluginRuntimeMock(),
        registerNodeHostCommand,
        registerNodeInvokePolicy,
        registerTool,
      }),
    );

    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(registerNodeInvokePolicy).toHaveBeenCalledOnce();
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "node_inference" }));
  });

  it("returns the exact model selected during provider auth setup", async () => {
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
            apiKey: "ollama-local",
            models: [{ id: "qwen-tool", name: "qwen-tool" }],
          },
        },
      },
    });
    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("ollama/qwen-tool");
    expect(result.configPatch?.models?.providers?.ollama?.apiKey).toBe("ollama-local");
  });

  it("discovers and prepares a loaded tool-capable model without pulling it", async () => {
    const provider = registerProvider();
    const guided = provider.auth[0].appGuidedSetup;
    mockDiscoveredOllamaProvider([
      { id: "embed-only", name: "embed-only", compat: { supportsTools: false } },
      { id: "unknown-tools", name: "unknown-tools" },
      { id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } },
    ]);

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

  it("detects a reachable Ollama service without requiring a suitable model", async () => {
    const provider = registerProvider();
    fetchOllamaModelsMock.mockResolvedValue({ reachable: true, models: [] });

    await expect(
      provider.auth[0].appGuidedSetup?.detectAvailability?.({ config: {}, env: {} }),
    ).resolves.toBe(true);
    expect(fetchOllamaModelsMock).toHaveBeenCalledWith("http://127.0.0.1:11434", {});
  });

  it("does not mark an unreachable Ollama service as available", async () => {
    const provider = registerProvider();
    fetchOllamaModelsMock.mockResolvedValue({ reachable: false, models: [] });

    await expect(
      provider.auth[0].appGuidedSetup?.detectAvailability?.({ config: {}, env: {} }),
    ).resolves.toBe(false);
  });

  it("uses the Docker host default for availability detection during Docker setup", async () => {
    const provider = registerProvider();
    fetchOllamaModelsMock.mockResolvedValue({ reachable: true, models: [] });

    await provider.auth[0].appGuidedSetup?.detectAvailability?.({
      config: {},
      env: { OPENCLAW_DOCKER_SETUP: "1" },
    });

    expect(fetchOllamaModelsMock).toHaveBeenCalledWith("http://host.docker.internal:11434", {});
  });

  it("does not auto-detect installed models that are not loaded", async () => {
    const provider = registerProvider();
    fetchLoadedOllamaModelNamesMock.mockResolvedValue({ reachable: true, models: [] });

    await expect(
      provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} }),
    ).resolves.toBeNull();

    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
    expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
  });

  it("prepares the exact configured model even when it is installed but idle", async () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama" as const,
            models: [
              {
                id: "qwen-tool",
                name: "qwen-tool",
                reasoning: false,
                input: ["text"] as const,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 8_192,
                compat: { supportsTools: true },
              },
            ],
          },
        },
      },
    };
    fetchLoadedOllamaModelNamesMock.mockResolvedValue({ reachable: true, models: [] });
    mockDiscoveredOllamaProvider([
      { id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } },
    ]);

    await expect(
      provider.auth[0].appGuidedSetup?.prepare({
        config,
        env: {},
        modelRef: "ollama/qwen-tool",
      }),
    ).resolves.toMatchObject({
      defaultModel: "ollama/qwen-tool",
      configPatch: {
        models: {
          providers: {
            ollama: {
              models: [expect.objectContaining({ id: "qwen-tool" })],
            },
          },
        },
      },
    });
    expect(fetchLoadedOllamaModelNamesMock).not.toHaveBeenCalled();
  });

  it("rejects an explicit installed model that setup did not configure", async () => {
    const provider = registerProvider();
    mockDiscoveredOllamaProvider([
      { id: "other-model", name: "other-model", compat: { supportsTools: true } },
    ]);

    await expect(
      provider.auth[0].appGuidedSetup?.prepare({
        config: {},
        env: {},
        modelRef: "ollama/other-model",
      }),
    ).resolves.toBeNull();
    expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
  });

  it("selects only from loaded models when stronger installed models are idle", async () => {
    const provider = registerProvider();
    fetchLoadedOllamaModelNamesMock.mockResolvedValue({
      reachable: true,
      models: ["llama3.3:70b"],
    });
    mockDiscoveredOllamaProvider([
      { id: "llama3.3:70b", name: "llama3.3:70b", compat: { supportsTools: true } },
      { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
    ]);

    await expect(provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} })).resolves.toEqual(
      {
        modelRef: "ollama/llama3.3:70b",
        detail: "llama3.3:70b at http://127.0.0.1:11434",
      },
    );
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledTimes(1);
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "llama3.3:70b",
      undefined,
    );
  });

  it("rechecks loaded state before preparing the detected route", async () => {
    const provider = registerProvider();
    mockDiscoveredOllamaProvider([
      { id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } },
    ]);

    await expect(provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} })).resolves.toEqual(
      {
        modelRef: "ollama/qwen-tool",
        detail: "qwen-tool at http://127.0.0.1:11434",
      },
    );
    fetchLoadedOllamaModelNamesMock.mockResolvedValue({ reachable: true, models: [] });

    await expect(
      provider.auth[0].appGuidedSetup?.prepare({
        config: {},
        env: {},
        modelRef: "ollama/qwen-tool",
      }),
    ).resolves.toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledTimes(1);
  });

  it("prefers the strongest tool-calling family among loaded models", async () => {
    const provider = registerProvider();
    mockDiscoveredOllamaProvider([
      { id: "llama3.3:70b", name: "llama3.3:70b", compat: { supportsTools: true } },
      { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
      {
        id: "nomic-embed-text",
        name: "nomic-embed-text",
        compat: { supportsTools: true },
      },
    ]);

    await expect(provider.auth[0].appGuidedSetup?.detect({ config: {}, env: {} })).resolves.toEqual(
      {
        modelRef: "ollama/qwen3.5:4b",
        detail: "qwen3.5:4b at http://127.0.0.1:11434",
      },
    );
  });

  it("skips preferred models whose measured context is below 16k", async () => {
    const provider = registerProvider();
    mockDiscoveredOllamaProvider([
      { id: "llama3.3:70b", name: "llama3.3:70b", compat: { supportsTools: true } },
      { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
    ]);
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
    mockDiscoveredOllamaProvider([
      { id: "qwen3.5:4b", name: "qwen3.5:4b", compat: { supportsTools: true } },
    ]);
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
    mockDiscoveredOllamaProvider(
      [{ id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } }],
      { baseUrl: "https://ollama.example.com" },
    );

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
    expect(fetchLoadedOllamaModelNamesMock).toHaveBeenCalledWith(
      "https://ollama.example.com",
      providerAccess,
    );
  });

  it("keeps environment-backed Ollama access for the completion proposal", async () => {
    const provider = registerProvider();
    const configuredValue = "environment-access";
    const providerAccess = { apiKey: configuredValue };
    const environment = { OLLAMA_API_KEY: configuredValue };
    mockDiscoveredOllamaProvider(
      [{ id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } }],
      { baseUrl: "https://ollama.example.com" },
    );

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
    mockDiscoveredOllamaProvider([
      { id: "qwen-tool", name: "qwen-tool", compat: { supportsTools: true } },
    ]);

    await provider.auth[0].appGuidedSetup?.detect({ config: {}, env: environment });

    const options = buildOllamaProviderMock.mock.calls.at(-1)?.[1] as
      | { apiKey?: string; quiet?: boolean }
      | undefined;
    expect(options?.apiKey).toBeUndefined();
    expect(fetchLoadedOllamaModelNamesMock).toHaveBeenCalledWith("http://127.0.0.1:11434", {});
  });

  it("honors the Ollama discovery opt-out during app-guided detection", async () => {
    const provider = registerProvider();
    const context = {
      config: {
        plugins: { entries: { ollama: { config: { discovery: { enabled: false } } } } },
      },
      env: {},
    };

    await expect(provider.auth[0].appGuidedSetup?.detect(context)).resolves.toBeNull();
    await expect(provider.auth[0].appGuidedSetup?.detectAvailability?.(context)).resolves.toBe(
      false,
    );
    expect(fetchLoadedOllamaModelNamesMock).not.toHaveBeenCalled();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
    expect(fetchOllamaModelsMock).not.toHaveBeenCalled();
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
    mockDiscoveredOllamaProvider([{ id: "llama3.2", name: "Llama 3.2" }], { once: true });

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
    mockDiscoveredOllamaProvider([], { once: true });

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

  it.each([
    { name: "treats non-default baseUrl as explicit discovery config", key: "baseUrl" },
    { name: "accepts baseURL alias as explicit discovery config", key: "baseURL" },
  ])("$name", async ({ key }) => {
    const provider = registerProvider();
    mockDiscoveredOllamaProvider([], { baseUrl: "http://remote-ollama:11434", once: true });

    const result = await provider.catalog.run({
      config: {
        models: {
          providers: {
            ollama: {
              [key]: "http://remote-ollama:11434",
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
    mockDiscoveredOllamaProvider([], { once: true });

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
    mockDiscoveredOllamaProvider(
      [
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
      { once: true },
    );
    const context = createDynamicModelContext("llama3.2:latest");

    try {
      const resolved = await provider.prepareDynamicModel?.(context as never);
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
    mockDiscoveredOllamaProvider(
      [
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
      { baseUrl: "https://ollama.example.com", once: true },
    );

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
      const context = createDynamicModelContext("qwen3-coder:cloud", config);

      const resolved = await provider.prepareDynamicModel?.(context as never);
      expect(resolved?.provider).toBe("ollama");
      expect(resolved?.id).toBe("qwen3-coder:cloud");
      expect(resolved?.api).toBe("openai-completions");
      expect(resolved?.baseUrl).toBe("https://ollama.example.com/v1");
      expect(buildOllamaProviderMock).toHaveBeenCalledWith("https://ollama.example.com/v1", {
        quiet: true,
        apiKey: "ollama-live",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  });

  it("authenticates configured dynamic Ollama discovery and model probes", async () => {
    const provider = registerProvider();
    const baseUrl = "https://dynamic-ollama.example.com";
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl,
            api: "ollama" as const,
            apiKey: "dynamic-discovery-access",
            models: [],
          },
        },
      },
    };
    mockDiscoveredOllamaProvider([], { baseUrl, once: true });
    const context = createDynamicModelContext("private-dynamic-model", config);

    const resolved = await provider.prepareDynamicModel?.(context as never);

    expect(buildOllamaProviderMock).toHaveBeenCalledWith(baseUrl, {
      quiet: true,
      apiKey: "dynamic-discovery-access",
    });
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(baseUrl, "private-dynamic-model", {
      apiKey: "dynamic-discovery-access",
    });
    expect(resolved?.id).toBe("private-dynamic-model");
  });

  it("returns the exact prepared Ollama model for concurrent credential profiles", async () => {
    const provider = registerProvider();
    const baseUrl = "https://shared-dynamic-ollama.example.com";
    const modelId = "tenant-dynamic-model";
    const configFor = (apiKey: string) => ({
      models: {
        providers: {
          ollama: { baseUrl, api: "ollama" as const, apiKey, models: [] },
        },
      },
    });
    const discoveredFor = (name: string) => ({
      baseUrl,
      api: "ollama" as const,
      models: [{ id: modelId, name, contextWindow: 8192, maxTokens: 2048 }],
    });
    const completeDiscovery: Array<(result: ReturnType<typeof discoveredFor>) => void> = [];
    buildOllamaProviderMock.mockImplementation(
      () =>
        new Promise<ReturnType<typeof discoveredFor>>((resolve) => {
          completeDiscovery.push(resolve);
        }),
    );

    const prepareFor = (apiKey: string, authProfileId: string) =>
      provider.prepareDynamicModel?.({
        ...createDynamicModelContext(modelId, configFor(apiKey)),
        authProfileId,
      } as never);
    const firstPrepared = prepareFor("first-tenant-access", "ollama:first");
    const secondPrepared = prepareFor("second-tenant-access", "ollama:second");

    await vi.waitFor(() => expect(buildOllamaProviderMock).toHaveBeenCalledTimes(2));
    completeDiscovery[1]?.(discoveredFor("Second tenant model"));
    await expect(secondPrepared).resolves.toMatchObject({
      id: modelId,
      name: "Second tenant model",
    });
    completeDiscovery[0]?.(discoveredFor("First tenant model"));
    await expect(firstPrepared).resolves.toMatchObject({ id: modelId, name: "First tenant model" });

    expect(buildOllamaProviderMock).toHaveBeenNthCalledWith(1, baseUrl, {
      quiet: true,
      apiKey: "first-tenant-access",
    });
    expect(buildOllamaProviderMock).toHaveBeenNthCalledWith(2, baseUrl, {
      quiet: true,
      apiKey: "second-tenant-access",
    });
  });

  it.each(["secretref-dynamic-access", "OLLAMA_API_KEY", OLLAMA_DEFAULT_API_KEY])(
    "preserves opaque environment-backed SecretRef value %s for dynamic discovery",
    async (secretValue) => {
      const provider = registerProvider();
      const baseUrl = "https://secretref-dynamic-ollama.example.com";
      const envId = "VITEST_OLLAMA_DYNAMIC_DISCOVERY_KEY";
      const previous = process.env[envId];
      process.env[envId] = secretValue;
      const config = {
        models: {
          providers: {
            ollama: {
              baseUrl,
              api: "ollama" as const,
              apiKey: { source: "env" as const, provider: "default", id: envId },
              models: [],
            },
          },
        },
      };
      mockDiscoveredOllamaProvider([], { baseUrl, once: true });
      const context = createDynamicModelContext("secretref-dynamic-model", config);

      try {
        const resolved = await provider.prepareDynamicModel?.(context as never);

        expect(resolved?.id).toBe("secretref-dynamic-model");
        expect(buildOllamaProviderMock).toHaveBeenCalledWith(baseUrl, {
          quiet: true,
          apiKey: secretValue,
        });
        expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
          baseUrl,
          "secretref-dynamic-model",
          { apiKey: secretValue },
        );
      } finally {
        if (previous === undefined) {
          delete process.env[envId];
        } else {
          process.env[envId] = previous;
        }
      }
    },
  );

  it("fails closed when a dynamic Ollama SecretRef cannot be resolved", async () => {
    const provider = registerProvider();
    const envId = "VITEST_OLLAMA_DYNAMIC_MISSING_KEY";
    const previous = process.env[envId];
    delete process.env[envId];
    const context = createDynamicModelContext("unreachable-private-model", {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://missing-secretref-ollama.example.com",
            api: "ollama",
            apiKey: { source: "env", provider: "default", id: envId },
            models: [],
          },
        },
      },
    });

    try {
      await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();

      expect(buildOllamaProviderMock).not.toHaveBeenCalled();
      expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) {
        process.env[envId] = previous;
      }
    }
  });

  it("keeps rotated managed SecretRefs request-owned and fails closed when unavailable", async () => {
    const provider = registerProvider();
    const baseUrl = "https://managed-dynamic-ollama.example.com";
    const modelId = "managed-private-model";
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl,
            api: "ollama" as const,
            apiKey: { source: "file" as const, provider: "default", id: "/ollama/apiKey" },
            models: [],
          },
        },
      },
    };
    resolveConfiguredSecretInputStringMock
      .mockResolvedValueOnce({ value: "managed-dynamic-access" })
      .mockResolvedValueOnce({ value: "rotated-managed-access" })
      .mockResolvedValueOnce({ unresolvedRefReason: "managed credential is unavailable" });
    mockDiscoveredOllamaProvider(
      [{ id: modelId, name: "Managed private model", contextWindow: 8192 }],
      { baseUrl, once: true },
    );
    mockDiscoveredOllamaProvider(
      [{ id: modelId, name: "Rotated managed model", contextWindow: 8192 }],
      { baseUrl, once: true },
    );
    const context = createDynamicModelContext(modelId, config);

    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toMatchObject({
      id: modelId,
      name: "Managed private model",
    });
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toMatchObject({
      id: modelId,
      name: "Rotated managed model",
    });
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();
    expect(buildOllamaProviderMock).toHaveBeenNthCalledWith(2, baseUrl, {
      quiet: true,
      apiKey: "rotated-managed-access",
    });
    expect(buildOllamaProviderMock).toHaveBeenCalledTimes(2);
  });

  it("isolates identically named managed SecretRefs by their resolved configuration", async () => {
    const provider = registerProvider();
    const baseUrl = "https://shared-managed-ollama.example.com";
    const modelId = "managed-tenant-model";
    const configFor = (tenant: string) => ({
      secrets: {
        providers: {
          default: { source: "file" as const, path: `/run/secrets/${tenant}.json` },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl,
            api: "ollama" as const,
            apiKey: { source: "file" as const, provider: "default", id: "/ollama/apiKey" },
            models: [],
          },
        },
      },
    });
    const firstConfig = configFor("first-tenant");
    const secondConfig = configFor("second-tenant");
    resolveConfiguredSecretInputStringMock
      .mockResolvedValueOnce({ value: "first-managed-tenant-access" })
      .mockResolvedValueOnce({ value: "second-managed-tenant-access" });
    mockDiscoveredOllamaProvider(
      [{ id: modelId, name: "First managed tenant model", contextWindow: 8192 }],
      { baseUrl, once: true },
    );
    mockDiscoveredOllamaProvider(
      [{ id: modelId, name: "Second managed tenant model", contextWindow: 8192 }],
      { baseUrl, once: true },
    );
    const contextFor = (config: typeof firstConfig) => createDynamicModelContext(modelId, config);

    const firstModel = await provider.prepareDynamicModel?.(contextFor(firstConfig) as never);
    const secondModel = await provider.prepareDynamicModel?.(contextFor(secondConfig) as never);

    expect(firstModel?.name).toBe("First managed tenant model");
    expect(secondModel?.name).toBe("Second managed tenant model");
    expect(buildOllamaProviderMock).toHaveBeenNthCalledWith(1, baseUrl, {
      quiet: true,
      apiKey: "first-managed-tenant-access",
    });
    expect(buildOllamaProviderMock).toHaveBeenNthCalledWith(2, baseUrl, {
      quiet: true,
      apiKey: "second-managed-tenant-access",
    });
  });

  it("resolves requested Ollama cloud models that are omitted from tags but confirmed by show", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-local";
    mockDiscoveredOllamaProvider(
      [
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
      { once: true },
    );
    mockOllamaShowInfo(["completion", "tools"]);
    const context = createDynamicModelContext("deepseek-v4-pro:cloud");

    try {
      const resolved = await provider.prepareDynamicModel?.(context as never);

      expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
        "http://127.0.0.1:11434",
        "deepseek-v4-pro:cloud",
      );
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
    mockOllamaShowInfo(["completion", "tools", "thinking"]);

    const rows = await augmentOllamaCatalog(provider, {
      config: {
        agents: {
          defaults: {
            models: {
              "ollama/minimax-m3:cloud@work": {},
            },
          },
        },
      },
    });

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
    mockOllamaShowInfo(["completion", "thinking"], { once: false });

    const rows = await augmentOllamaCatalog(provider, {
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
    });

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

  it.each([
    {
      name: "augments configured Ollama Cloud refs with resolved auth",
      baseUrl: "https://ollama.com",
      modelId: "cloud-new:cloud",
      resolvedApiKey: "cloud-key",
      expectedApiKey: "cloud-key",
      capabilities: ["completion", "thinking"],
    },
    {
      name: "augments configured remote Ollama refs with configured auth",
      baseUrl: "https://ollama.example.test",
      modelId: "remote-new",
      configuredApiKey: "remote-key",
      resolvedApiKey: "",
      expectedApiKey: "remote-key",
      capabilities: ["completion", "tools", "thinking"],
    },
  ])(
    "$name",
    async ({
      baseUrl,
      modelId,
      configuredApiKey,
      resolvedApiKey,
      expectedApiKey,
      capabilities,
    }) => {
      const provider = registerProvider();
      mockOllamaShowInfo(capabilities);

      const rows = await augmentOllamaCatalog(provider, {
        config: {
          agents: {
            defaults: {
              models: {
                [`ollama/${modelId}`]: {},
              },
            },
          },
          models: {
            providers: {
              ollama: {
                baseUrl,
                api: "ollama",
                ...(configuredApiKey ? { apiKey: configuredApiKey } : {}),
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: vi.fn(() => ({ apiKey: resolvedApiKey })),
      });

      expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(baseUrl, modelId, {
        apiKey: expectedApiKey,
      });
      expect(rows).toEqual([
        expect.objectContaining({
          provider: "ollama",
          id: modelId,
          reasoning: true,
          contextWindow: 1_048_576,
        }),
      ]);
    },
  );

  it.each(["$OLLAMA_API_KEY", "${OLLAMA_API_KEY}"])(
    "resolves configured Ollama Cloud SecretInput auth string %s",
    async (apiKeyRef) => {
      const provider = registerProvider();
      mockOllamaShowInfo(["completion", "thinking"]);

      await augmentOllamaCatalog(provider, {
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
        resolveProviderApiKey: vi.fn(() => ({
          apiKey: "OLLAMA_API_KEY",
          discoveryApiKey: "cloud-key",
        })),
      });

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
    mockOllamaShowInfo(["completion", "tools", "thinking"]);

    await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "LOCAL_OLLAMA_API_KEY",
        discoveryApiKey: "local-key",
      })),
    });

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "local-secured",
      { apiKey: "local-key" },
    );
  });

  it("does not attach ambient OLLAMA_API_KEY to local show probes", async () => {
    const provider = registerProvider();
    mockOllamaShowInfo(["completion", "tools"]);

    await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "OLLAMA_API_KEY",
        discoveryApiKey: "ambient-cloud-key",
      })),
    });

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434",
      "local-open",
    );
  });

  it("augments configured first-class Ollama Cloud provider refs", async () => {
    const provider = registerOllamaCloudProvider();
    mockOllamaShowInfo(["completion", "thinking"]);

    const rows = await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "cloud-key" })),
    });

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
    mockOllamaShowInfo(["completion", "thinking"]);

    await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({ apiKey: "ollama-local" })),
    });

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-config-key" },
    );
  });

  it("uses resolved discovery auth instead of non-secret markers for Ollama Cloud probes", async () => {
    const provider = registerOllamaCloudProvider();
    mockOllamaShowInfo(["completion", "thinking"]);

    await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "secretref-managed", // pragma: allowlist secret
        discoveryApiKey: "cloud-key",
      })),
    });

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith(
      "https://ollama.com",
      "cloud-new:cloud",
      { apiKey: "cloud-key" },
    );
  });

  it("does not probe Ollama Cloud catalog with non-secret auth markers", async () => {
    const provider = registerOllamaCloudProvider();

    const rows = await augmentOllamaCatalog(provider, {
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
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "secretref-managed", // pragma: allowlist secret
      })),
    });

    expect(queryOllamaModelShowInfoMock).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("augments id-only configured Ollama provider rows with live show capabilities", async () => {
    const provider = registerProvider();
    mockOllamaShowInfo(["completion", "tools", "thinking", "vision"]);

    const rows = await augmentOllamaCatalog(provider, {
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "Configured Minimax M3",
          api: "openai-completions",
        },
      ],
    });

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
    mockOllamaShowInfo(["completion", "tools", "thinking", "vision"]);

    const rows = await augmentOllamaCatalog(provider, {
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "minimax-m3:cloud",
          contextWindow: 128_000,
        },
      ],
    });

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

    const rows = await augmentOllamaCatalog(provider, {
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
    });

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

    const rows = await augmentOllamaCatalog(provider, {
      entries: Array.from({ length: 5 }, (_, index) => ({
        provider: "ollama",
        id: `model-${index}:cloud`,
        name: `model-${index}:cloud`,
      })),
    });

    expect(rows).toHaveLength(5);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("caps configured Ollama show probes", async () => {
    const provider = registerProvider();
    mockOllamaShowInfo(["completion", "thinking"], { once: false });

    const rows = await augmentOllamaCatalog(provider, {
      entries: Array.from({ length: 10 }, (_, index) => ({
        provider: "ollama",
        id: `model-${index}:cloud`,
        name: `model-${index}:cloud`,
      })),
    });

    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledTimes(8);
    expect(rows).toHaveLength(8);
  });

  it("keeps unknown requested Ollama models unresolved when show inspection fails", async () => {
    const provider = registerProvider();
    const previous = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-local";
    mockDiscoveredOllamaProvider([], { once: true });
    queryOllamaModelShowInfoMock.mockResolvedValueOnce({ showInspectionFailed: true });
    const context = createDynamicModelContext("depseek-v4-pro:cloud");

    try {
      await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();
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

  it.each(["127.0.0.2", "[::ffff:127.0.0.2]", "[::ffff:7f00:2]"])(
    "treats custom 127/8 Ollama provider %s as loopback for implicit discovery",
    async (hostname) => {
      const provider = registerProvider();
      mockDiscoveredOllamaProvider([], { once: true });

      const result = await provider.catalog.run({
        config: {
          models: {
            providers: {
              "ollama-alt-local": {
                api: "ollama",
                baseUrl: `http://${hostname}:11434`,
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
    },
  );

  it.each([
    {
      name: "does not mint synthetic auth for empty default-ish provider stubs",
      providerPatch: { baseUrl: "http://127.0.0.1:11434" },
      mintsAuth: false,
    },
    {
      name: "mints synthetic auth for non-default explicit ollama config",
      providerPatch: { baseUrl: "http://remote-ollama:11434" },
      mintsAuth: true,
    },
    {
      name: "mints synthetic auth for non-default baseURL alias config",
      providerPatch: { baseURL: "http://remote-ollama:11434" },
      mintsAuth: true,
    },
    {
      name: "does not mint synthetic auth for Ollama Cloud baseUrl",
      providerPatch: { baseUrl: "https://ollama.com" },
      mintsAuth: false,
    },
  ])("$name", ({ providerPatch, mintsAuth }) => {
    const provider = registerProvider();
    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        api: "ollama",
        models: [],
        ...providerPatch,
      } as never,
    });
    if (mintsAuth) {
      expect(auth).toEqual({
        apiKey: "ollama-local",
        source: "models.providers.ollama (synthetic local key)",
        mode: "api-key",
      });
    } else {
      expect(auth).toBeUndefined();
    }
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
      "minimax-m2.7",
      "minimax-m3",
      "kimi-k3",
      "glm-5.1",
      "glm-5.2",
    ]);
    expect(result.provider.models).toEqual([
      expect.objectContaining({
        id: "minimax-m2.7",
        contextWindow: 196_608,
        reasoning: true,
        input: ["text"],
        compat: { supportsTools: true, supportsUsageInStreaming: true },
      }),
      expect.objectContaining({
        id: "minimax-m3",
        contextWindow: 524_288,
        reasoning: true,
        input: ["text", "image"],
        compat: { supportsTools: true, supportsUsageInStreaming: true },
      }),
      expect.objectContaining({
        id: "kimi-k3",
        contextWindow: 1_048_576,
        reasoning: true,
        input: ["text", "image"],
        compat: { supportsTools: true, supportsUsageInStreaming: true },
      }),
      expect.objectContaining({
        id: "glm-5.1",
        contextWindow: 202_752,
        reasoning: true,
        input: ["text"],
        compat: { supportsTools: true, supportsUsageInStreaming: true },
      }),
      expect.objectContaining({
        id: "glm-5.2",
        contextWindow: 1_000_000,
        reasoning: true,
        input: ["text"],
        compat: { supportsTools: true, supportsUsageInStreaming: true },
      }),
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
    mockDiscoveredOllamaProvider([buildOllamaModelDefinitionMock("glm-5.2")], {
      baseUrl: "https://ollama.com",
      once: true,
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
      expect.arrayContaining([expect.objectContaining({ id: "glm-5.2", name: "glm-5.2" })]),
    );
  });

  it("confirms GLM-5.2 with authenticated show when cloud tags omit it", async () => {
    const provider = registerOllamaCloudProvider();
    mockDiscoveredOllamaProvider([buildOllamaModelDefinitionMock("kimi-k2.6")], {
      baseUrl: "https://ollama.com",
      once: true,
    });
    mockOllamaShowInfo(["completion", "thinking", "tools"], { contextWindow: 1_000_000 });
    const result = await provider.catalog.run({
      config: {
        agents: { defaults: { model: { primary: "ollama-cloud/glm-5.2" } } },
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
    expect(queryOllamaModelShowInfoMock).toHaveBeenCalledWith("https://ollama.com", "glm-5.2", {
      apiKey: "cloud-key",
    });
    expect(result?.provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "glm-5.2",
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
      modelId: "glm-5.2",
    } as never);

    expect(model).toEqual(
      expect.objectContaining({
        provider: "ollama-cloud",
        id: "glm-5.2",
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

  it.each([
    {
      name: "routes createStreamFn to the correct provider baseUrl for ollama2",
      providerId: "ollama2",
      baseUrlKey: "baseUrl",
      expectedBaseUrl: "http://127.0.0.1:11435",
    },
    {
      name: "routes createStreamFn through baseURL alias for custom Ollama providers",
      providerId: "ollama2",
      baseUrlKey: "baseURL",
      expectedBaseUrl: "http://127.0.0.1:11435",
    },
    {
      name: "uses ollama provider baseUrl when provider is ollama (backward compat)",
      providerId: "ollama",
      baseUrlKey: "baseUrl",
      expectedBaseUrl: "http://127.0.0.1:11434",
    },
  ])("$name", ({ providerId, baseUrlKey, expectedBaseUrl }) => {
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
            [baseUrlKey]: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { id: "llama3.2", provider: providerId, api: "ollama", baseUrl: undefined };

    provider.createStreamFn?.({ config, model, provider: providerId } as never);

    expect(requireConfiguredStreamParams().providerBaseUrl).toBe(expectedBaseUrl);
  });

  it("preserves the configured provider key for local-service acquisition", () => {
    const provider = registerProvider();
    provider.createStreamFn?.({
      config: {
        models: {
          providers: {
            "Ollama-GPU": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11435",
              models: [],
            },
          },
        },
      },
      model: {
        id: "llama3.2",
        provider: "ollama-gpu",
        api: "ollama",
      },
      provider: "ollama-gpu",
    } as never);

    expect(requireConfiguredStreamParams()).toMatchObject({
      providerBaseUrl: "http://127.0.0.1:11435",
      localService: {
        providerId: "Ollama-GPU",
        acquire: expect.any(Function),
      },
    });
  });

  it.each([
    {
      name: "wraps native Ollama payloads with top-level think=false when thinking is off",
      thinkingLevel: "off" as const,
      expectedThink: false,
    },
    ...(["low", "medium", "high"] as const).map((thinkingLevel) => ({
      name: `preserves native Ollama ${thinkingLevel} thinking on the wire`,
      thinkingLevel,
      expectedThink: thinkingLevel,
    })),
    {
      name: "keeps the compatible local Ollama max mapping",
      thinkingLevel: "max" as const,
      expectedThink: "high",
    },
    {
      name: "does not set think param when thinkingLevel is undefined",
      thinkingLevel: undefined,
      expectedThink: undefined,
    },
  ])("$name", ({ thinkingLevel, expectedThink }) => {
    const { baseStreamFn, payloadSeen } = captureWrappedOllamaPayload(thinkingLevel);
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(expectedThink);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("preserves native Ollama Cloud max thinking on the wire", () => {
    const { payloadSeen } = captureWrappedOllamaPayload("max", {
      provider: "ollama-cloud",
      modelId: "glm-5.2",
      baseUrl: "https://ollama.com",
    });

    expect(payloadSeen?.think).toBe("max");
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
      levels: [
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "max" },
      ],
      defaultLevel: "off",
    });
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
        runtime: createPluginRuntimeMock(),
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
    expect(ollamaMedia.describeImage).toBeTypeOf("function");
    expect(ollamaMedia.describeImages).toBeTypeOf("function");
    // Intentional: no defaultModels or autoPriority. Ollama vision models are
    // user-installed (llava, qwen2.5vl, …) with no universal default, and we
    // don't want Ollama to auto-steal image duty from configured providers.
    expect(ollamaMedia.defaultModels).toBeUndefined();
    expect(ollamaMedia.autoPriority).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
