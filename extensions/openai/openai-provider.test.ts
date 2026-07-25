// Openai tests cover openai provider plugin behavior.
import fs from "node:fs";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_API_BASE_URL, OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";
import { OPENAI_CODEX_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from "./default-models.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";

const mocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
  openAIResponsesTransportStreamFn: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));

async function runCatalogWithFetchGuard(params: {
  fetchGuard: LiveModelCatalogFetchGuard;
  auth: {
    mode: "api_key" | "oauth";
    apiKey: string;
    discoveryApiKey?: string;
    profileId?: string;
    source: string;
  };
  accountId?: string;
  baseUrl?: string;
}): Promise<ModelProviderConfig> {
  if (params.auth.mode === "oauth") {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      ...params.auth,
      source: params.auth.source,
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: params.auth.profileId,
      accountId: params.accountId,
    });
  }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const guarded = await params.fetchGuard({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    await guarded.release();
    return guarded.response;
  });
  try {
    const result = await buildOpenAIProvider().catalog?.run({
      resolveProviderAuth: () => params.auth,
      resolveProviderApiKey: () => ({
        apiKey: params.auth.apiKey,
        discoveryApiKey: params.auth.discoveryApiKey,
      }),
      config: params.baseUrl
        ? { models: { providers: { openai: { baseUrl: params.baseUrl, models: [] } } } }
        : { auth: { profiles: {} } },
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
    } as never);
    if (!result || "provider" in result || !result.providers.openai) {
      throw new Error("expected OpenAI live provider catalog");
    }
    return result.providers.openai;
  } finally {
    fetchSpy.mockRestore();
  }
}

async function buildOpenAILiveProviderConfig(params: {
  apiKey: string;
  baseUrl?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return await runCatalogWithFetchGuard({
    fetchGuard: params.fetchGuard,
    auth: { mode: "api_key", apiKey: params.apiKey, source: "profile" },
    baseUrl: params.baseUrl,
  });
}

async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return await runCatalogWithFetchGuard({
    fetchGuard: params.fetchGuard,
    auth: {
      mode: "oauth",
      apiKey: params.discoveryApiKey,
      profileId: "openai:chatgpt",
      source: "profile",
    },
    accountId: params.accountId,
  });
}

vi.mock("./openai-chatgpt-provider.runtime.js", () => ({
  refreshOpenAICodexToken: mocks.refreshOpenAICodexToken,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveProviderAuthProfileMetadata: mocks.resolveProviderAuthProfileMetadata,
}));

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-stream-family")>();
  const wrapStreamFn: NonNullable<typeof actual.OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn> = (
    ctx,
  ) => {
    let nextStreamFn = actual.createOpenAIAttributionHeadersWrapper(ctx.streamFn);

    if (actual.resolveOpenAIFastMode(ctx.extraParams)) {
      nextStreamFn = actual.createOpenAIFastModeWrapper(nextStreamFn);
    }

    const serviceTier = actual.resolveOpenAIServiceTier(ctx.extraParams);
    if (serviceTier) {
      nextStreamFn = actual.createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
    }

    const textVerbosity = actual.resolveOpenAITextVerbosity(ctx.extraParams);
    if (textVerbosity) {
      nextStreamFn = actual.createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
    }

    nextStreamFn = actual.createCodexNativeWebSearchWrapper(nextStreamFn, {
      config: ctx.config,
      agentDir: ctx.agentDir,
      agentId: ctx.agentId,
    });
    return actual.createOpenAIResponsesContextManagementWrapper(
      actual.createOpenAIReasoningCompatibilityWrapper(nextStreamFn),
      ctx.extraParams,
    );
  };

  return {
    buildProviderStreamFamilyHooks: actual.buildProviderStreamFamilyHooks,
    createCodexNativeWebSearchWrapper: actual.createCodexNativeWebSearchWrapper,
    createOpenAIAttributionHeadersWrapper: actual.createOpenAIAttributionHeadersWrapper,
    createOpenAIFastModeWrapper: actual.createOpenAIFastModeWrapper,
    createOpenAIReasoningCompatibilityWrapper: actual.createOpenAIReasoningCompatibilityWrapper,
    createOpenAIResponsesContextManagementWrapper:
      actual.createOpenAIResponsesContextManagementWrapper,
    createOpenAIServiceTierWrapper: actual.createOpenAIServiceTierWrapper,
    createOpenAITextVerbosityWrapper: actual.createOpenAITextVerbosityWrapper,
    getOpenRouterModelCapabilities: actual.getOpenRouterModelCapabilities,
    loadOpenRouterModelCapabilities: actual.loadOpenRouterModelCapabilities,
    resolveOpenAIFastMode: actual.resolveOpenAIFastMode,
    resolveOpenAIServiceTier: actual.resolveOpenAIServiceTier,
    resolveOpenAITextVerbosity: actual.resolveOpenAITextVerbosity,
    OPENAI_RESPONSES_STREAM_HOOKS: {
      ...actual.OPENAI_RESPONSES_STREAM_HOOKS,
      wrapStreamFn,
    },
  };
});

const OPENAI_CODEX_MODELS_URL = `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=${readPinnedCodexClientVersion()}`;

function readPinnedCodexClientVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../codex/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, unknown> };
  const version = packageJson.dependencies?.["@openai/codex"];
  if (typeof version !== "string") {
    throw new Error("expected an exact @openai/codex dependency");
  }
  return version;
}

function runWrappedPayloadCase(params: {
  wrap: NonNullable<ReturnType<typeof buildOpenAIProvider>["wrapStreamFn"]>;
  provider: string;
  modelId: string;
  model:
    | Model<"openai-responses">
    | Model<"openai-chatgpt-responses">
    | Model<"azure-openai-responses">;
  extraParams?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  agentId?: string;
  nativeWebSearchAllowedByToolPolicy?: boolean;
  payload?: Record<string, unknown>;
}) {
  const payload = params.payload ?? { store: false };
  let capturedOptions: SimpleStreamOptions | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedOptions = options;
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const streamFn = params.wrap({
    provider: params.provider,
    modelId: params.modelId,
    extraParams: params.extraParams,
    config: params.cfg as never,
    agentDir: "/tmp/openai-provider-test",
    agentId: params.agentId,
    nativeWebSearchAllowedByToolPolicy: params.nativeWebSearchAllowedByToolPolicy,
    streamFn: baseStreamFn,
  } as never);

  const context: Context = { messages: [] };
  void streamFn?.(params.model, context, {});

  return {
    payload,
    options: capturedOptions,
  };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectCatalogEntry(entries: unknown, id: string, expected: Record<string, unknown>): void {
  expect(Array.isArray(entries)).toBe(true);
  const entry = (entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === id,
  );
  expectFields(entry, expected);
}

function expectNoCatalogEntry(entries: unknown, id: string): void {
  expect(Array.isArray(entries)).toBe(true);
  const entryIds = new Set((entries as Array<Record<string, unknown>>).map((entry) => entry.id));
  expect(entryIds.has(id)).toBe(false);
}

describe("buildOpenAIProvider", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    mocks.resolveApiKeyForProvider.mockReset();
    mocks.resolveProviderAuthProfileMetadata.mockReset();
    mocks.openAIResponsesTransportStreamFn.mockReset();
    mocks.openAIResponsesTransportStreamFn.mockImplementation(() => {
      throw new Error("unexpected native OpenAI Responses transport call");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes grouped model/auth picker labels for API key setup", () => {
    const provider = buildOpenAIProvider();
    const apiKey = provider.auth.find((method) => method.id === "api-key");

    expect(provider.hookAliases).toEqual(["azure-openai", "azure-openai-responses"]);
    expect(provider.catalog).toBeDefined();
    expectFields(apiKey?.wizard, {
      choiceLabel: "OpenAI API Key",
      choiceHint: "Use your OpenAI API key directly",
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "ChatGPT/Codex sign-in or API key",
    });
    expect(apiKey?.starterModel).toBe("openai/gpt-5.6");
  });

  it("preserves existing model selection during non-interactive API key setup", async () => {
    const provider = buildOpenAIProvider();
    const apiKey = provider.auth.find((method) => method.id === "api-key");
    if (!apiKey?.runNonInteractive) {
      throw new Error("expected OpenAI API key non-interactive auth");
    }
    const primaryModel = "anthropic/claude-opus-4-6";
    const fallbackModel = "openai/gpt-5.5";

    const next = await apiKey.runNonInteractive({
      config: {
        agents: {
          defaults: {
            model: { primary: primaryModel, fallbacks: [fallbackModel] },
            models: {
              [primaryModel]: { alias: "Primary" },
              [fallbackModel]: { alias: "Fallback" },
            },
          },
        },
      },
      opts: {},
      env: {},
      runtime: {},
      resolveApiKey: async () => ({ key: "sk-test", source: "profile" }),
      toApiKeyCredential: () => null,
    } as never);

    expect(next?.agents?.defaults?.model).toEqual({
      primary: primaryModel,
      fallbacks: [fallbackModel],
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      [primaryModel]: { alias: "Primary" },
      [fallbackModel]: { alias: "Fallback" },
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });

  it("classifies OpenAI-native code-only failover errors", () => {
    const provider = buildOpenAIProvider();

    for (const providerId of ["openai", "azure-openai", "azure-openai-responses"]) {
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "SERVER_ERROR",
        }),
      ).toBe("server_error");
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "INSUFFICIENT_QUOTA",
        }),
      ).toBe("billing");
    }
    // API_ERROR is an Anthropic-native code, not OpenAI's: fall through to generic.
    expect(
      provider.classifyFailoverReason?.({
        provider: "openai",
        errorMessage: "",
        code: "API_ERROR",
      }),
    ).toBeUndefined();
  });

  it("marks the OpenAI manifest catalog as runtime-discovered", () => {
    expect(manifest.modelCatalog.discovery.openai).toBe("runtime");
  });

  it("does not hardcode chatgpt-responses transport on gpt-5.3-codex catalog entry (#91710)", () => {
    const openaiModels = manifest.modelCatalog.providers.openai.models as Array<
      Record<string, unknown>
    >;
    const codexEntry = openaiModels.find((m) => m.id === "gpt-5.3-codex");
    expect(codexEntry).toBeDefined();
    expect(codexEntry?.api).toBeUndefined();
    expect(codexEntry?.baseUrl).toBeUndefined();
  });

  it("keeps a network-free OpenAI static catalog", async () => {
    const provider = buildOpenAIProvider();

    const result = await provider.staticCatalog?.run({
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none",
        source: "none",
      }),
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      config: {},
      env: {},
    } as never);

    if (!result || "provider" in result) {
      throw new Error("expected OpenAI static provider catalog");
    }
    const gpt55 = result.providers.openai?.models.find((model) => model.id === "gpt-5.5");
    const gpt56Models = result.providers.openai?.models.filter((model) =>
      model.id.startsWith("gpt-5.6"),
    );
    expect(gpt55?.mediaInput).toEqual({
      image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
    });
    expect(gpt56Models?.map((model) => model.id)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(gpt56Models?.map((model) => model.contextWindow)).toEqual([
      1_050_000, 1_050_000, 1_050_000, 1_050_000,
    ]);
    expect(gpt56Models?.map((model) => model.thinkingLevelMap?.off)).toEqual([
      "none",
      "none",
      "none",
      "none",
    ]);
    expect(gpt56Models?.map((model) => model.compat?.supportedReasoningEfforts)).toEqual(
      Array.from({ length: 4 }, () => ["none", "low", "medium", "high", "xhigh", "max"]),
    );
    expect(OPENAI_DEFAULT_MODEL).toBe("openai/gpt-5.6");
    expect(OPENAI_CODEX_DEFAULT_MODEL).toBe("openai/gpt-5.6-sol");
  });

  it("scopes the OpenAI API-key catalog to the OpenAI provider id", async () => {
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "gpt-5.5", object: "model" }],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "api_key",
          apiKey: "sk-openai",
          discoveryApiKey: "sk-discovery",
          source: "profile",
        }),
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI live provider catalog");
      }
      expect(Object.keys(result.providers)).toEqual(["openai"]);
      expect(result.providers.openai?.apiKey).toBe("sk-openai");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const fetchInit = fetchSpy.mock.calls[0]?.[1];
      const headers = fetchInit?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer sk-discovery");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to direct API-key catalog discovery when OAuth resolution fails", async () => {
    mocks.resolveApiKeyForProvider.mockRejectedValue(new Error("expired oauth profile"));
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "gpt-5.5", object: "model" }],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "oauth",
          apiKey: "stale-oauth-token",
          profileId: "openai:chatgpt",
          source: "profile",
        }),
        resolveProviderApiKey: () => ({
          apiKey: "sk-openai",
          discoveryApiKey: "sk-discovery",
        }),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI live provider catalog");
      }
      expect(result.providers.openai?.api).toBe("openai-responses");
      expect(result.providers.openai?.apiKey).toBe("sk-openai");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer sk-discovery");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("filters the OpenAI API-key catalog against live model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          { id: "gpt-5.6", object: "model" },
          { id: "gpt-5.5", object: "model" },
          { id: "not-in-manifest", object: "model" },
        ],
      }),
      finalUrl: "https://api.openai.com/v1/models",
      release,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("sk-openai");
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.6");
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(provider.models.map((model) => model.id)).not.toContain("not-in-manifest");
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe("https://api.openai.com/v1/models");
    const init = fetchParams?.init;
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe("Bearer sk-openai");
    expect(release).toHaveBeenCalledOnce();
  });

  it("skips OpenAI live discovery for custom OpenAI-compatible base URLs", async () => {
    const customBaseUrl = "https://example-proxy.invalid/v1";
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => {
      throw new Error("unexpected OpenAI live discovery request");
    });

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-custom-openai-compatible",
      baseUrl: customBaseUrl,
      fetchGuard,
    });

    expect(fetchGuard).not.toHaveBeenCalled();
    expect(provider.baseUrl).toBe(customBaseUrl);
    expect(provider.api).toBe("openai-responses");
    expect(provider.apiKey).toBe("sk-custom-openai-compatible");
    const apiModel = provider.models.find((model) => model.api !== "openai-chatgpt-responses");
    expect(apiModel?.baseUrl).toBe(customBaseUrl);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: apiModel?.id,
        configuredProvider: { api: provider.api, baseUrl: customBaseUrl },
        observedRoutes: apiModel ? [{ api: apiModel.api, baseUrl: apiModel.baseUrl }] : [],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: provider.api, baseUrl: customBaseUrl }],
    });
  });

  it("uses the Codex backend catalog for OpenAI OAuth discovery", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "medium", description: "medium" },
              { effort: "high", description: "high" },
              { effort: "xhigh", description: "xhigh" },
              { effort: "max", description: "max" },
            ],
            input_modalities: ["text", "image"],
            context_window: 372_000,
            max_context_window: 372_000,
          },
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "medium", description: "medium" },
              { effort: "high", description: "high" },
            ],
            input_modalities: ["text", "image"],
            context_window: 272_000,
            max_context_window: 1_000_000,
            max_output_tokens: 128_000,
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6 Terra",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
          },
          {
            slug: "gpt-5.3-codex-spark",
            display_name: "GPT-5.3 Codex Spark",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "high", description: "high" }],
            context_window: 200_000,
            max_output_tokens: 64_000,
          },
          {
            slug: "codex-auto-review",
            display_name: "Codex Auto Review",
            visibility: "hide",
          },
          {
            slug: "codex-internal-fallback",
            display_name: "Codex Internal Fallback",
            visibility: "none",
          },
        ],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "oauth",
          apiKey: "stale-oauth-token",
          profileId: "openai:chatgpt",
          source: "profile",
        }),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
        profileId: "openai:chatgpt",
        lockedProfile: true,
      });
      expect(mocks.resolveProviderAuthProfileMetadata).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        profileId: "openai:chatgpt",
      });
      const openai = result.providers.openai;
      expect(openai?.api).toBe("openai-chatgpt-responses");
      expect(openai?.auth).toBe("oauth");
      expect(openai?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      expect(openai?.models.map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.5",
        "gpt-5.6-terra",
        "gpt-5.3-codex-spark",
      ]);
      expect(openai?.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
        contextWindow: 372_000,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
      const liveSol = openai?.models.find((model) => model.id === "gpt-5.6-sol");
      expect(
        provider.resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentRuntime: "codex",
          api: "openai-chatgpt-responses",
          compat: liveSol?.compat,
        } as never)?.levels,
      ).not.toContainEqual({ id: "ultra" });
      expect(openai?.models.find((model) => model.id === "gpt-5.6-terra")).toMatchObject({
        contextWindow: 372_000,
        contextTokens: 272_000,
      });
      expect(openai?.models.find((model) => model.id === "gpt-5.3-codex-spark")).toMatchObject({
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(OPENAI_CODEX_MODELS_URL);
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer fresh-oauth-token");
      expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the managed Codex package version for OAuth model discovery", async () => {
    const pinnedVersion = readPinnedCodexClientVersion();
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async (params) => ({
      response: Response.json({ models: [{ slug: "gpt-5.5", visibility: "list" }] }),
      finalUrl: params.url,
      release: async () => undefined,
    }));

    await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "placeholder",
      fetchGuard,
    });

    const requestUrl = vi.mocked(fetchGuard).mock.calls[0]?.[0].url;
    expect(new URL(requestUrl ?? "https://placeholder").searchParams.get("client_version")).toBe(
      pinnedVersion,
    );
  });

  it("uses runtime OAuth profiles when catalog auth resolution is empty", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
          },
        ],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "none",
          apiKey: undefined,
          discoveryApiKey: undefined,
          source: "none",
        }),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      });
      expect(result.providers.openai?.api).toBe("openai-chatgpt-responses");
      expect(result.providers.openai?.auth).toBe("oauth");
      expect(result.providers.openai?.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("maps direct Codex catalog rows into OpenAI ChatGPT response models", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "medium", description: "medium" },
              { effort: "high", description: "high" },
            ],
            context_window: 272_000,
            max_context_window: 1_050_000,
            max_output_tokens: 128_000,
          },
          {
            slug: "hidden-review-model",
            display_name: "Hidden Review Model",
            visibility: "hide",
          },
          {
            slug: "internal-fallback-model",
            display_name: "Internal Fallback Model",
            visibility: "none",
          },
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      accountId: "acct-openai-workspace",
      fetchGuard,
    });

    expect(provider?.api).toBe("openai-chatgpt-responses");
    expect(provider?.auth).toBe("oauth");
    expect(provider?.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    expect(provider?.models[0]).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe(OPENAI_CODEX_MODELS_URL);
    const init = fetchParams?.init;
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe("Bearer oauth-token");
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
    expect(release).toHaveBeenCalledOnce();
  });

  it("caps base and forward-compatible GPT-5.6 Codex catalog rows", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6",
            display_name: "GPT-5.6",
            visibility: "list",
            context_window: 372_000,
            max_context_window: 1_050_000,
          },
          {
            slug: "gpt-5.6-preview-2026-07-22",
            display_name: "GPT-5.6 Preview",
            visibility: "list",
            context_window: 400_000,
            max_context_window: 1_050_000,
          },
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      fetchGuard,
    });

    expect(provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6",
          contextWindow: 1_050_000,
          contextTokens: 272_000,
        }),
        expect.objectContaining({
          id: "gpt-5.6-preview-2026-07-22",
          contextWindow: 1_050_000,
          contextTokens: 272_000,
        }),
      ]),
    );
  });

  it("keeps an explicit empty Codex reasoning catalog authoritative", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: [],
          },
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "empty-reasoning-oauth-token",
      fetchGuard,
    });
    const sol = provider.models.find((model) => model.id === "gpt-5.6-sol");

    expect(sol?.compat?.supportedReasoningEfforts).toEqual([]);
    expect(sol?.thinkingLevelMap).toEqual({ off: null });
    expect(
      buildOpenAIProvider().resolveThinkingProfile?.({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentRuntime: "codex",
        api: "openai-chatgpt-responses",
        compat: sol?.compat,
      } as never)?.levels,
    ).not.toContainEqual({ id: "ultra" });
  });

  it.each([
    ["fails", () => new Response("temporarily unavailable", { status: 503 })],
    ["returns no models", () => Response.json({ models: [] })],
    [
      "returns hidden-only models",
      () =>
        Response.json({
          models: [
            { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "hide" },
            { slug: "gpt-5.5", display_name: "GPT-5.5", show_in_picker: false },
          ],
        }),
    ],
  ])("keeps static OpenAI OAuth rows when Codex catalog discovery %s", async (_label, response) => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: response(),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      accountId: "acct-openai-workspace",
      fetchGuard,
    });

    expect(provider.api).toBe("openai-chatgpt-responses");
    expect(provider.auth).toBe("oauth");
    expect(provider.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(provider.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
      contextWindow: 372_000,
      contextTokens: 272_000,
      thinkingLevelMap: { off: null },
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    });
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6-terra");
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6-luna");
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the deprecated Codex provider builder on the public API barrel", async () => {
    const { buildOpenAICodexProviderPlugin } = await import("./api.js");
    const provider = buildOpenAICodexProviderPlugin();

    expect(provider.id).toBe("openai");
    expect(provider.hookAliases).toEqual(["azure-openai", "azure-openai-responses"]);
  });

  it.each(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "prefers auth-aware Codex runtime metadata for %s over static OpenAI catalog rows",
    (modelId) => {
      const provider = buildOpenAIProvider();

      expect(
        provider.preferRuntimeResolvedModel?.({
          provider: "openai",
          modelId,
        } as never),
      ).toBe(true);
    },
  );

  it("normalizes legacy OpenAI Codex hook aliases through the Codex transport", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.normalizeTransport?.({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      } as never),
    ).toEqual({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(
      provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          provider: "openai",
          id: "gpt-5.4-codex",
          name: "gpt-5.4-codex",
          api: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      } as never),
    ).toMatchObject({
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text", "image"],
    });
  });

  it("upgrades catalog Completions metadata but preserves authored official adapters", () => {
    const provider = buildOpenAIProvider();
    const transport = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as const;

    for (const baseUrl of [
      "https://api.openai.com/v1",
      "https://api.openai.com:443/v1",
      "https://api.openai.com./v1",
    ]) {
      expect(provider.normalizeTransport?.({ ...transport, baseUrl } as never)).toEqual({
        api: "openai-responses",
        baseUrl,
      });
    }
    expect(
      provider.normalizeTransport?.({
        ...transport,
        baseUrl: "http://api.openai.com/v1",
      } as never),
    ).toBeUndefined();
    for (const config of [
      {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.5", api: "openai-completions" }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            OpenAI: {
              api: "openai-responses",
              baseUrl: "https://case-distinct.example/v1",
              models: [],
            },
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
    ]) {
      expect(provider.normalizeTransport?.({ ...transport, config } as never)).toBeUndefined();
      expect(
        provider.normalizeResolvedModel?.({
          ...transport,
          config,
          model: {
            provider: "openai",
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
        } as never),
      ).toMatchObject({ api: "openai-completions" });
    }

    const legacyAliasConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            models: [{ id: "OpenAI/GPT-5.4-CODEX", api: "openai-completions" }],
          },
        },
      },
    };
    expect(
      provider.normalizeTransport?.({
        ...transport,
        modelId: "gpt-5.4",
        config: legacyAliasConfig,
      } as never),
    ).toBeUndefined();

    expect(
      provider.normalizeTransport?.({
        ...transport,
        provider: "OpenAI",
        config: {
          models: {
            providers: {
              OpenAI: { api: "openai-responses", models: [] },
              openai: { api: "openai-completions", models: [] },
            },
          },
        },
      } as never),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("preserves authored Completions independently of route eligibility", () => {
    const provider = buildOpenAIProvider();
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: OPENAI_API_BASE_URL,
            models: [{ id: "gpt-5.3-codex-spark" }],
          },
        },
      },
    };
    const observedTransport = {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
      config,
    } as const;

    expect(provider.normalizeTransport?.(observedTransport as never)).toEqual({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
    expect(
      provider.normalizeResolvedModel?.({
        ...observedTransport,
        model: {
          provider: "openai",
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          api: "openai-chatgpt-responses",
          baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        },
      } as never),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
  });

  it("preserves the environment base URL for authored Completions", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example.test/v1");
    const provider = buildOpenAIProvider();

    expect(
      provider.normalizeTransport?.({
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        config: {
          models: {
            providers: {
              openai: { api: "openai-completions", models: [{ id: "gpt-5.5" }] },
            },
          },
        },
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
    });
  });

  it("preserves authored Responses", () => {
    const provider = buildOpenAIProvider();
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: OPENAI_API_BASE_URL,
    } as const;
    const authoredResponsesConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: OPENAI_API_BASE_URL,
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    };

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: "gpt-5.5",
        model,
        config: authoredResponsesConfig,
      } as never),
    ).toEqual(model);
    expect(
      provider.normalizeTransport?.({
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: OPENAI_API_BASE_URL,
        config: authoredResponsesConfig,
      } as never),
    ).toBeUndefined();
  });

  it("lets an authored Completions route replace observed ChatGPT transport metadata", () => {
    vi.stubEnv("OPENAI_BASE_URL", "");
    const provider = buildOpenAIProvider();
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    };
    const observedTransport = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
      config,
    } as const;

    expect(provider.normalizeTransport?.(observedTransport as never)).toEqual({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
    expect(
      provider.normalizeResolvedModel?.({
        ...observedTransport,
        model: {
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5",
          api: "openai-chatgpt-responses",
          baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        },
      } as never),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
  });

  it("resolves gpt-5.4 mini and nano from GPT-5 small-model templates", () => {
    const provider = buildOpenAIProvider();
    const registry = {
      find(providerId: string, id: string) {
        if (providerId !== "openai") {
          return null;
        }
        if (id === "gpt-5-mini") {
          return {
            id,
            name: "GPT-5 mini",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400_000,
            maxTokens: 128_000,
          };
        }
        if (id === "gpt-5-nano") {
          return {
            id,
            name: "GPT-5 nano",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          };
        }
        return null;
      },
    };

    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: registry as never,
    });
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry as never,
    });

    expectFields(mini, {
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expectFields(nano, {
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("surfaces gpt-5.4 mini and nano in xhigh and augmented catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.4-mini",
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.4-nano",
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
      ],
    } as never);

    expectCatalogEntry(entries, "gpt-5.4-mini", {
      provider: "openai",
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
    });
    expectCatalogEntry(entries, "gpt-5.4-nano", {
      provider: "openai",
      id: "gpt-5.4-nano",
      name: "gpt-5.4-nano",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
    });
  });

  it("owns native reasoning output mode for OpenAI and Azure OpenAI responses", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "azure-openai-responses",
        modelApi: "azure-openai-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("routes GPT forward-compat models by the projected route, not profile order", () => {
    const provider = buildOpenAIProvider();

    const openaiModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
      },
    } as never);
    const unselectedPlatformModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
      config: {
        auth: {
          profiles: {
            "openai:oauth": {
              provider: "openai",
              mode: "oauth",
            },
            "openai:api-key": {
              provider: "openai",
              mode: "api_key",
            },
          },
          order: {
            openai: ["openai:oauth", "openai:api-key"],
          },
        },
      },
    } as never);
    const unprojectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
    } as never);
    const selectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
      providerConfig: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    } as never);

    expectFields(openaiModel, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
    expectFields(unselectedPlatformModel, {
      provider: "openai",
      id: "gpt-5.6",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
    expectFields(unprojectedOauthModel, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expectFields(selectedOauthModel, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it("keeps HTTP Platform routes out of Codex transport gates", () => {
    const provider = buildOpenAIProvider();
    const baseUrl = "http://api.openai.com/v1";
    const providerConfig = {
      api: "openai-responses",
      baseUrl,
      models: [],
    } as const;

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileMode: "oauth",
      providerConfig,
    } as never);
    expect(model?.api).toBe("openai-responses");

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: { effort: "high" },
        config: {
          models: { providers: { openai: providerConfig } },
          auth: {
            profiles: {
              "openai:default": { provider: "openai", mode: "oauth" },
            },
          },
        },
      } as never),
    ).toEqual({ effort: "high", transport: "sse" });
  });

  it("restores gpt-5.3-codex-spark only through ChatGPT/Codex OAuth routing", () => {
    const provider = buildOpenAIProvider();

    const oauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
    } as never);
    const apiKeyModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const runtimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
    } as never);
    const apiKeyRuntimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
      authProfileId: "openai:api-key",
      authProfileMode: "api_key",
      providerConfig: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const unknownModelHint = provider.buildUnknownModelHint?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    } as never);

    expectFields(oauthModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expectFields(runtimeModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expect(apiKeyModel).toBeUndefined();
    expect(apiKeyRuntimeModel).toBeUndefined();
    expect(unknownModelHint).toContain("ChatGPT/Codex OAuth");
    expect(unknownModelHint).toContain("OpenAI API-key auth cannot use this model");
  });

  it("resolves chat-latest as an explicit direct API model override", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "chat-latest",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.5"
            ? {
                id,
                name: "GPT-5.5",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });

    expectFields(model, {
      provider: "openai",
      id: "chat-latest",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });

    const fallback = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "chat-latest",
      modelRegistry: { find: () => null },
    } as never);

    expectFields(fallback, {
      provider: "openai",
      id: "chat-latest",
      api: "openai-responses",
      reasoning: false,
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it("resolves gpt-5.5 locally without cached catalog metadata", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.4"
            ? {
                id,
                name: "GPT-5.4",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });

    expectFields(model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it.each([
    {
      id: "gpt-5.6",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    },
    {
      id: "gpt-5.6-sol",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    },
    {
      id: "gpt-5.6-terra",
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    },
    {
      id: "gpt-5.6-luna",
      cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    },
  ])("resolves $id locally with direct API metadata", ({ id, cost, thinkingLevelMap }) => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      modelRegistry: {
        find: (_provider: string, templateId: string) =>
          templateId === "gpt-5.5"
            ? {
                id: templateId,
                name: "GPT-5.5",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 1_000_000,
                contextTokens: 272_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    } as never);

    expectFields(model, {
      id,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost,
      thinkingLevelMap,
    });
  });

  it("resolves gpt-5.5-pro locally", () => {
    const provider = buildOpenAIProvider();

    const pro = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.4-pro"
            ? {
                id,
                name: "GPT-5.4 Pro",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });

    expectFields(pro, {
      provider: "openai",
      id: "gpt-5.5-pro",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("keeps Codex-family OpenAI models on the Codex thinking policy", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.3-codex-spark",
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.3",
        } as never)
        ?.levels.map((level) => level.id),
    ).not.toContain("xhigh");
  });

  it("passes the selected runtime into GPT-5.6 thinking policy", () => {
    const provider = buildOpenAIProvider();
    const openClawLuna = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "openclaw",
    } as never);
    const codexLuna = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      api: "openai-responses",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    } as never);
    const codexSolFromDirectCatalog = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      api: "openai-responses",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    } as never);
    const codexSolFromNativeCatalog = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      api: "openai-chatgpt-responses",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    } as never);

    expect(openClawLuna?.levels.map((level) => level.id)).toContain("ultra");
    expect(codexLuna?.levels.map((level) => level.id)).not.toContain("ultra");
    expect(codexLuna?.levels.map((level) => level.id)).toContain("max");
    expect(codexSolFromDirectCatalog?.levels.map((level) => level.id)).toContain("ultra");
    expect(codexSolFromNativeCatalog?.levels.map((level) => level.id)).toContain("ultra");
  });

  it("keeps chat-latest and gpt-5.5 out of synthetic catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.5",
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
    } as never);

    expectNoCatalogEntry(entries, "gpt-5.5");
    expectNoCatalogEntry(entries, "chat-latest");
  });

  it("keeps modern live selection on current OpenAI and Codex models", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAIProvider();

    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.0",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2",
      } as never),
    ).toBe(false);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "chat-latest",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(true);

    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.1-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.1-codex-max",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.2-codex",
      } as never),
    ).toBe(false);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(true);
    expect(
      codexProvider.isModernModelRef?.({
        provider: "openai",
        modelId: "gpt-5.5",
      } as never),
    ).toBe(true);
  });

  it("owns replay policy for OpenAI and Codex transports", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAIProvider();

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      codexProvider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });
  });

  it("owns direct OpenAI wrapper composition for responses payloads", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const extraParams = provider.prepareExtraParams?.({
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        textVerbosity: "low",
      },
    } as never);
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: extraParams ?? undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none" },
      },
    });

    expectFields(extraParams, {
      transport: "sse",
    });
    expect(result.payload.store).toBe(true);
    expect(result.payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 140_000 },
    ]);
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "low" });
    expect(result.payload.reasoning).toEqual({ effort: "none" });
    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("clamps chat-latest text verbosity to the only live-supported value", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const extraParams = provider.prepareExtraParams?.({
      provider: "openai",
      modelId: "chat-latest",
      extraParams: {
        textVerbosity: "low",
      },
    } as never);
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "chat-latest",
      extraParams: extraParams ?? undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "chat-latest",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
      } as Model<"openai-responses">,
      payload: {
        text: { verbosity: "high" },
      },
    });

    expect(result.payload.text).toEqual({ verbosity: "medium" });
  });

  it("uses native OpenAI web search instead of the managed web_search function", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "read" },
      { type: "web_search" },
    ]);
  });

  it("keeps one native OpenAI web search tool when the payload is already patched", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [{ type: "web_search" }, { type: "function", name: "web_search" }],
        reasoning: { effort: "minimal" },
      },
    });

    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
    expect(result.payload.reasoning).toEqual({ effort: "low" });
  });

  it("keeps managed OpenAI web_search when agent policy denies native web search", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
      nativeWebSearchAllowedByToolPolicy: false,
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              tools: { deny: ["web_search"] },
            },
          ],
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "read" },
      { type: "function", name: "web_search" },
    ]);
  });

  it("raises minimal reasoning when native OpenAI web search is injected", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "minimal", summary: "auto" },
      },
    });

    expect(result.payload.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("does not inject native OpenAI web search when disabled or proxied", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const disabled = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: false } } } },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });
    const proxied = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example-proxy.invalid/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(disabled.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(proxied.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
  });

  it("keeps managed web_search when another search provider is configured", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: true, provider: "brave" } } } },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(result.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
  });

  it("preserves explicit OpenAI responses transport overrides", () => {
    const provider = buildOpenAIProvider();

    const explicit = {
      transport: "websocket",
      fastMode: true,
    };

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("does not infer Codex transport from an unselected OAuth profile", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: { effort: "high" },
        config: {
          auth: {
            profiles: {
              "openai:default": {
                provider: "openai",
                mode: "oauth",
              },
            },
          },
        },
      } as never),
    ).toEqual({
      effort: "high",
      transport: "sse",
    });
    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        } as Model<"openai-chatgpt-responses">,
        extraParams: { effort: "high" },
      }),
    ).toEqual({
      effort: "high",
      transport: "auto",
    });

    const explicit = {
      transport: "sse",
    };
    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("shares OpenAI responses wrapper composition across provider variants", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAIProvider();

    expect(provider.wrapStreamFn).toBe(codexProvider.wrapStreamFn);
    expect(provider.buildReplayPolicy).toBe(codexProvider.buildReplayPolicy);
    expect(provider.resolveTransportTurnState).toBe(codexProvider.resolveTransportTurnState);
    expect(provider.resolveWebSocketSessionPolicy).toBe(
      codexProvider.resolveWebSocketSessionPolicy,
    );
  });

  it("owns Azure OpenAI reasoning compatibility without forcing OpenAI transport defaults", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected Azure OpenAI wrapper");
    }
    const result = runWrappedPayloadCase({
      wrap,
      provider: "azure-openai-responses",
      modelId: "gpt-5.4",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as Model<"azure-openai-responses">,
      payload: {
        reasoning: { effort: "none" },
      },
    });

    expect(result.options?.transport).toBeUndefined();
    expect(result.payload.reasoning).toEqual({ effort: "none" });
  });

  it("falls back to cached codex oauth credentials on accountId extraction failures", async () => {
    const provider = buildOpenAIProvider();
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
    };

    mocks.refreshOpenAICodexToken.mockReset();
    mocks.refreshOpenAICodexToken.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
