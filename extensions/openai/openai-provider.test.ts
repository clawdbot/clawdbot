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
import { OPENAI_DEFAULT_MODEL } from "./default-models.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";

const mocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
  openAIResponsesTransportStreamFn: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));

type OpenAITestCatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly {
    provider: string;
    profileId?: string;
    status: "ready" | "auth-rejected" | "unavailable";
  }[];
};

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
}): Promise<OpenAITestCatalogResult> {
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
    return { provider: result.providers.openai, outcomes: result.outcomes ?? [] };
  } finally {
    fetchSpy.mockRestore();
  }
}

async function buildOpenAILiveProviderConfig(params: {
  apiKey: string;
  baseUrl?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return (
    await runCatalogWithFetchGuard({
      fetchGuard: params.fetchGuard,
      auth: { mode: "api_key", apiKey: params.apiKey, source: "profile" },
      baseUrl: params.baseUrl,
    })
  ).provider;
}

async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return (
    await runCatalogWithFetchGuard({
      fetchGuard: params.fetchGuard,
      auth: {
        mode: "oauth",
        apiKey: params.discoveryApiKey,
        profileId: "openai:chatgpt",
        source: "profile",
      },
      accountId: params.accountId,
    })
  ).provider;
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
  context?: Context;
  streamOptions?: SimpleStreamOptions & {
    openclawCodeModeToolSurface?: boolean;
    openclawCodeModeAllowedHostedToolTypes?: Set<string>;
  };
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

  void streamFn?.(params.model, params.context ?? { messages: [] }, params.streamOptions ?? {});

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
    expect(apiKey?.starterModel).toBe("openai/gpt-5.6-sol");
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

  it("does not hardcode transport routing on static catalog entries (#91710)", () => {
    const openaiModels = manifest.modelCatalog.providers.openai.models as Array<
      Record<string, unknown>
    >;
    expect(openaiModels.length).toBeGreaterThan(0);
    // Transport selection is runtime-owned; a manifest row pinning api/baseUrl
    // would bypass route policy (the original #91710 regression).
    for (const entry of openaiModels) {
      expect(entry.api, `catalog row ${String(entry.id)} must not pin api`).toBeUndefined();
      expect(entry.baseUrl, `catalog row ${String(entry.id)} must not pin baseUrl`).toBeUndefined();
    }
  });

  it("keeps a network-free OpenAI static catalog without the duplicate GPT-5.6 alias", async () => {
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
    const gpt54Models = result.providers.openai?.models.filter((model) =>
      model.id.startsWith("gpt-5.4"),
    );
    const gpt56Models = result.providers.openai?.models.filter((model) =>
      model.id.startsWith("gpt-5.6"),
    );
    expect(gpt55?.mediaInput).toEqual({
      image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
    });
    expect(gpt56Models?.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(gpt56Models?.map((model) => model.contextWindow)).toEqual([
      1_050_000, 1_050_000, 1_050_000,
    ]);
    expect(gpt56Models?.map((model) => model.thinkingLevelMap?.off)).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(gpt56Models?.map((model) => model.compat?.supportedReasoningEfforts)).toEqual(
      Array.from({ length: 3 }, () => ["none", "low", "medium", "high", "xhigh", "max"]),
    );
    expect(gpt54Models).toMatchObject([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      },
      {
        id: "gpt-5.4-pro",
        name: "GPT-5.4 Pro",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
      },
      {
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
        cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
      },
    ]);
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
        providerIds: ["openai"],
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

  it.each(["azure-openai", "azure-openai-responses"])(
    "does not resolve OpenAI credentials or fetch for %s-only catalog scope",
    async (providerId) => {
      const provider = buildOpenAIProvider();
      const resolveProviderAuth = vi.fn(() => ({
        mode: "api_key" as const,
        apiKey: "sk-openai",
        source: "profile" as const,
      }));
      const resolveProviderApiKey = vi.fn(() => ({ apiKey: "sk-openai" }));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ data: [{ id: "gpt-5.5", object: "model" }] }));

      try {
        await expect(
          provider.catalog?.run({
            providerIds: [providerId],
            resolveProviderAuth,
            resolveProviderApiKey,
            config: {},
            env: {},
          }),
        ).resolves.toBeNull();
        expect(resolveProviderAuth).not.toHaveBeenCalled();
        expect(resolveProviderApiKey).not.toHaveBeenCalled();
        expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

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
          { id: "chat-latest", object: "model" },
          { id: "gpt-5.4", object: "model" },
          { id: "gpt-5.4-pro", object: "model" },
          { id: "gpt-5.4-mini", object: "model" },
          { id: "gpt-5.4-nano", object: "model" },
          { id: "gpt-5.3-codex-spark", object: "model" },
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
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "chat-latest",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
      ]),
    );
    expect(provider.models.find((model) => model.id === "chat-latest")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: false,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-pro")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-mini")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-nano")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
    });
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.3-codex-spark");
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

  it("does not surface platform models omitted by the account's live catalog", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({ data: [{ id: "gpt-5.5", object: "model" }] }),
      finalUrl: "https://api.openai.com/v1/models",
      release: async () => undefined,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai",
      fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
  });

  it.each([
    ["returns an empty model list", () => Response.json({ data: [] })],
    [
      "returns only unsupported models",
      () => Response.json({ data: [{ id: "not-in-manifest", object: "model" }] }),
    ],
    ["rejects the API key", () => new Response("unauthorized", { status: 401 })],
    ["denies account access", () => new Response("forbidden", { status: 403 })],
  ])("does not invent available OpenAI models when discovery %s", async (_label, response) => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: response(),
      finalUrl: "https://api.openai.com/v1/models",
      release,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai-unavailable",
      fetchGuard,
    });

    expect(provider.models).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps only manifest fallback models when OpenAI discovery is unavailable", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: new Response("temporarily unavailable", { status: 503 }),
      finalUrl: "https://api.openai.com/v1/models",
      release: async () => undefined,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai",
      fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.openai.models.map((model) => model.id),
    );
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
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
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
      ).toContainEqual({ id: "ultra" });
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

  it("rejects Platform-only aliases while preserving GPT-5.6 ChatGPT capabilities", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6",
            visibility: "list",
          },
          {
            slug: "chat-latest",
            visibility: "list",
          },
          {
            slug: "gpt-5.6-preview-2026-07-22",
            visibility: "list",
            context_window: 400_000,
            max_context_window: 1_050_000,
          },
          ...["sol", "terra", "luna"].map((tier) => ({
            slug: `gpt-5.6-${tier}`,
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "high", description: "high" },
              ...(tier === "luna" ? [{ effort: "ultra", description: "ultra" }] : []),
            ],
          })),
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      fetchGuard,
    });

    expectNoCatalogEntry(provider.models, "gpt-5.6");
    expectNoCatalogEntry(provider.models, "chat-latest");
    expectCatalogEntry(provider.models, "gpt-5.6-preview-2026-07-22", {
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
    for (const tier of ["sol", "terra"] as const) {
      expect(provider.models.find((model) => model.id === `gpt-5.6-${tier}`)).toMatchObject({
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      });
    }
    expect(provider.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
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

  it("keeps static OpenAI OAuth rows when Codex catalog discovery fails", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: new Response("temporarily unavailable", { status: 503 }),
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

  it.each([
    ["returns no models", () => Response.json({ models: [] })],
    [
      "returns only hidden models",
      () =>
        Response.json({
          models: [
            { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "hide" },
            { slug: "gpt-5.5", display_name: "GPT-5.5", show_in_picker: false },
          ],
        }),
    ],
    ["rejects the subscription token", () => new Response("unauthorized", { status: 401 })],
    ["denies account access", () => new Response("forbidden", { status: 403 })],
  ])("does not invent OAuth models when the account catalog %s", async (_label, response) => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: response(),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token-no-visible-models",
      accountId: "acct-openai-workspace",
      fetchGuard,
    });

    expect(provider.api).toBe("openai-chatgpt-responses");
    expect(provider.auth).toBe("oauth");
    expect(provider.models).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports when the account catalog rejects saved OAuth credentials", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: new Response("unauthorized", { status: 401 }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const result = await runCatalogWithFetchGuard({
      fetchGuard,
      auth: {
        mode: "oauth",
        apiKey: "rejected-oauth-token",
        profileId: "openai:chatgpt",
        source: "profile",
      },
    });

    expect(result.provider.models).toEqual([]);
    expect(result.outcomes).toEqual([
      { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
    ]);
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

  it("delegates an unlisted first-party model to its explicitly selected Codex runtime", () => {
    const provider = buildOpenAIProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-future",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-future",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
          api: model?.api,
          compat: model?.compat,
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("max");
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
        } as never)
        ?.levels.map((level) => level.id),
    ).toEqual(expect.arrayContaining(["xhigh", "max"]));
  });

  it("does not invent an unlisted model for authored Platform credentials", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-future",
        modelRegistry: { find: () => null },
        agentRuntimeId: "codex",
        authProfileId: "openai:platform",
        authProfileMode: "api_key",
        providerConfig: {
          auth: "api-key",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      } as never),
    ).toBeUndefined();
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
          api: "openai-responses",
        } as never)
        ?.levels.map((level) => level.id),
    ).not.toContain("max");
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

  it("synthesizes the gpt-5.6 alias from the nearest direct API template", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6",
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
      id: "gpt-5.6",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    });
  });

  it.each([
    {
      id: "gpt-5.6-sol",
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    },
    {
      id: "gpt-5.6-terra",
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
    },
    {
      id: "gpt-5.6-luna",
      cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  ])("preserves exact registry metadata for $id", ({ id, cost }) => {
    const provider = buildOpenAIProvider();
    const exactModel = {
      id,
      name: id,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost,
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      compat: { supportedReasoningEfforts: ["registry-exact"] },
    };

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      modelRegistry: {
        find: (_provider: string, templateId: string) => (templateId === id ? exactModel : null),
      } as never,
    } as never);

    expect(model).toBe(exactModel);
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

  it.each([
    { modelId: "gpt-5.4", contextWindow: 1_050_000 },
    { modelId: "gpt-5.4-pro", contextWindow: 1_050_000 },
    { modelId: "gpt-5.4-mini", contextWindow: 400_000 },
    { modelId: "gpt-5.4-nano", contextWindow: 400_000 },
  ])(
    "restores native image capability to an existing $modelId catalog row",
    ({ modelId, contextWindow }) => {
      const provider = buildOpenAIProvider();
      const existingRoute = {
        provider: "openai",
        id: modelId,
        name: `Stale ${modelId}`,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        contextWindow: 8_192,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      };

      const entries = provider.augmentModelCatalog?.({
        env: process.env,
        entries: [existingRoute],
      } as never);

      expectCatalogEntry(entries, modelId, {
        provider: "openai",
        id: modelId,
        name: modelId,
        api: existingRoute.api,
        baseUrl: existingRoute.baseUrl,
        reasoning: true,
        input: ["text", "image"],
        contextWindow,
        cost: existingRoute.cost,
      });
    },
  );

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

  it("authorizes native OpenAI web search through the code mode wrapper chain", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const allowedHostedToolTypes = new Set<string>();

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
      context: {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      streamOptions: {
        openclawCodeModeToolSurface: true,
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
      payload: {
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "rogue" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
    ]);
    expect(allowedHostedToolTypes).toEqual(new Set(["web_search"]));
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

    const allowedHostedToolTypes = new Set<string>();
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
      nativeWebSearchAllowedByToolPolicy: false,
      streamOptions: {
        openclawCodeModeToolSurface: true,
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
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
    expect(allowedHostedToolTypes).toEqual(new Set());
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

    const disabledAllowedHostedToolTypes = new Set<string>();
    const disabled = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: false } } } },
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: disabledAllowedHostedToolTypes,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });
    const proxiedAllowedHostedToolTypes = new Set<string>();
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
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: proxiedAllowedHostedToolTypes,
      },
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(disabled.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(proxied.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(disabledAllowedHostedToolTypes).toEqual(new Set());
    expect(proxiedAllowedHostedToolTypes).toEqual(new Set());
  });

  it("keeps managed web_search when another search provider is configured", () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const allowedHostedToolTypes = new Set<string>();
    const result = runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: true, provider: "brave" } } } },
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(result.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(allowedHostedToolTypes).toEqual(new Set());
  });

  it("defaults direct OpenAI API-key traffic to SSE and preserves explicit WebSocket", () => {
    const provider = buildOpenAIProvider();

    const explicit = {
      transport: "websocket",
      fastMode: true,
    };

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        },
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                auth: "api-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        extraParams: { effort: "high" },
      } as never),
    ).toEqual({ effort: "high", transport: "sse" });

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("uses SSE for an unselected OAuth profile and native defaults for a Codex route", () => {
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
