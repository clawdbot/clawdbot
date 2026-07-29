// Lmstudio tests cover index plugin behavior.
import type { OpenClawConfig, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./src/defaults.js";

const fetchLmstudioModelsMock = vi.hoisted(() => vi.fn());

vi.mock("./src/models.fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/models.fetch.js")>()),
  fetchLmstudioModels: fetchLmstudioModelsMock,
}));

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected the LM Studio plugin to register a provider");
  }
  expect(provider.id).toBe("lmstudio");
  return provider;
}

function requireLmstudioResetValidator(): NonNullable<
  ProviderAuthMethod["validateNonInteractive"]
> {
  const validator = registerProvider().auth[0]?.validateNonInteractive;
  if (!validator) {
    throw new Error(
      "expected the LM Studio provider to register a non-interactive reset validator",
    );
  }
  return validator;
}

function createLmstudioResetValidationContext(
  opts: Record<string, unknown> = {},
  resolvedApiKey: { key: string; source: "flag" | "env" | "profile" } | null = null,
): Parameters<NonNullable<ProviderAuthMethod["validateNonInteractive"]>>[0] {
  return {
    authChoice: "lmstudio",
    config: {},
    baseConfig: {},
    opts,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
    },
    resolveApiKey: vi.fn(async () => resolvedApiKey),
  };
}

function createRemoteProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "http://lmstudio.internal:1234/v1",
    models: [
      {
        id: "qwen/qwen3.5-9b",
        name: "Qwen 3.5 9B",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
    ...overrides,
  };
}

describe("lmstudio plugin", () => {
  beforeEach(() => {
    fetchLmstudioModelsMock.mockReset();
  });

  it("registers llama.cpp GBNF tool-schema projection", () => {
    expect(registerProvider()).toMatchObject({
      normalizeToolSchemas: expect.any(Function),
      inspectToolSchemas: expect.any(Function),
    });
  });

  it("preflights the requested LM Studio model before destructive non-interactive reset", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [{ type: "llm", key: "qwen/qwen3.5-9b" }],
    });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/api/v1/",
      customModelId: "qwen/qwen3.5-9b",
    });

    const validateNonInteractive = requireLmstudioResetValidator();
    expect(validateNonInteractive).toBeTypeOf("function");
    await expect(validateNonInteractive(ctx)).resolves.toBe(true);

    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://lmstudio.internal:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      timeoutMs: 5000,
    });
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it("uses the provider-specific API key for read-only reset discovery", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [{ type: "llm", key: "qwen/qwen3.5-9b" }],
    });
    const ctx = createLmstudioResetValidationContext(
      {
        customBaseUrl: "http://lmstudio.internal:1234/v1",
        customModelId: "qwen/qwen3.5-9b",
        lmstudioApiKey: "lmstudio-test-key",
        customApiKey: "custom-test-key",
      },
      { key: "lmstudio-test-key", source: "flag" },
    );

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(true);

    expect(ctx.resolveApiKey).toHaveBeenCalledWith({
      provider: "lmstudio",
      flagValue: "lmstudio-test-key",
      flagName: "--lmstudio-api-key",
      envVar: "LM_API_TOKEN",
      envVarName: "LM_API_TOKEN",
      required: false,
    });
    expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl: "http://lmstudio.internal:1234/v1",
      apiKey: "lmstudio-test-key",
      timeoutMs: 5000,
    });
  });

  it("rejects an unreachable LM Studio endpoint before destructive reset", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({ reachable: false, models: [] });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/v1",
    });

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(false);

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://lmstudio.internal:1234/v1.\nStart LM Studio (or run lms server start) and re-run setup.",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects LM Studio authentication failures before destructive reset", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 401, models: [] });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/v1",
    });

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(false);

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio returned HTTP 401 while listing models at http://lmstudio.internal:1234/v1.\nCheck the base URL and API key, then re-run setup.",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a missing requested LM Studio model before destructive reset", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [{ type: "llm", key: "phi-4" }],
    });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/v1",
      customModelId: "qwen/qwen3.5-9b",
    });

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(false);

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio model qwen/qwen3.5-9b was not found at http://lmstudio.internal:1234/v1.\nAvailable models: phi-4",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects provider-qualified model IDs that LM Studio setup cannot select", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [{ type: "llm", key: "qwen/qwen3.5-9b" }],
    });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/v1",
      customModelId: "lmstudio/qwen/qwen3.5-9b",
    });

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(false);

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "LM Studio model lmstudio/qwen/qwen3.5-9b was not found at http://lmstudio.internal:1234/v1.\nAvailable models: qwen/qwen3.5-9b",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects an LM Studio endpoint without a usable LLM before destructive reset", async () => {
    fetchLmstudioModelsMock.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [{ type: "embedding", key: "text-embedding-nomic" }],
    });
    const ctx = createLmstudioResetValidationContext({
      customBaseUrl: "http://lmstudio.internal:1234/v1",
    });

    await expect(requireLmstudioResetValidator()(ctx)).resolves.toBe(false);

    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "No LM Studio LLM models were found at http://lmstudio.internal:1234/v1.\nLoad at least one model in LM Studio (or run lms load), then re-run setup.",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("canonicalizes base URLs during provider normalization", () => {
    const provider = registerProvider();
    const providerConfig = createRemoteProviderConfig({
      baseUrl: "http://localhost:1234/api/v1/",
    });

    expect(
      provider?.normalizeConfig?.({
        provider: "lmstudio",
        providerConfig,
      }),
    ).toEqual({
      ...providerConfig,
      baseUrl: "http://localhost:1234/v1",
      request: { allowPrivateNetwork: true },
    });
  });

  it("synthesizes placeholder auth for configured lmstudio models without API key auth", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          headers: {
            "X-Proxy-Auth": "proxy-token",
          },
        }),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });
  });

  it("still synthesizes placeholder auth when explicit api-key auth has no key", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          auth: "api-key",
        }),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });
  });

  it("does not synthesize placeholder auth when Authorization header is configured", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).toBeUndefined();
  });

  it("defers stored lmstudio-local profile auth so real credentials can win", () => {
    const provider = registerProvider();

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      }),
    ).toBe(true);

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: CUSTOM_LOCAL_AUTH_MARKER,
      }),
    ).toBe(true);

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: "lmstudio-real-key",
      }),
    ).toBe(false);
  });

  it("augments the catalog with configured lmstudio models", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          lmstudio: {
            models: [
              {
                id: "qwen3-8b-instruct",
                name: "Qwen 3 8B Instruct",
                contextWindow: 32768,
                contextTokens: 8192,
                reasoning: true,
                input: ["text", "image"],
                compat: {
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["off", "on"],
                  reasoningEffortMap: { off: "off", high: "on" },
                },
              },
              {
                id: "phi-4",
              },
              {
                id: " ",
                name: "ignored",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      provider?.augmentModelCatalog?.({
        config,
        agentDir: "/tmp/openclaw",
        env: {},
        entries: [],
      }),
    ).toEqual([
      {
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
        name: "Qwen 3 8B Instruct",
        compat: {
          supportsUsageInStreaming: true,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
        },
        contextWindow: 32768,
        contextTokens: 8192,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        provider: "lmstudio",
        id: "phi-4",
        name: "phi-4",
        compat: { supportsUsageInStreaming: true },
        contextWindow: undefined,
        contextTokens: undefined,
        reasoning: undefined,
        input: undefined,
      },
    ]);
  });
});
