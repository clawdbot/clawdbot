// Xai tests cover index plugin behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildLiveXaiOAuthProvider, buildLiveXaiProvider } from "./provider-catalog.js";
import setupPlugin from "./setup-api.js";
import {
  createXaiPayloadCaptureStream,
  expectXaiFastToolStreamShaping,
  runXaiGrok4ResponseStream,
} from "./test-helpers.js";

function createProviderModel(overrides: {
  id: string;
  api?: string;
  baseUrl?: string;
  provider?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.id,
    api: overrides.api ?? "openai-completions",
    provider: overrides.provider ?? "xai",
    baseUrl: overrides.baseUrl ?? "https://api.x.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

type XaiAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerXaiAutoEnableProbe(): XaiAutoEnableProbe {
  const probes: XaiAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected xAI setup plugin to register an auto-enable probe");
  }
  return probe;
}

function requireEntry<T extends { id?: string }>(entries: T[], id: string): T {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Expected entry ${id}`);
  }
  return entry;
}

type XaiBilledToolName = "code_execution" | "x_search";

function registerXaiBilledToolFactories() {
  const tools = new Map<string, Parameters<OpenClawPluginApi["registerTool"]>[0]>();
  plugin.register(
    createTestPluginApi({
      registerTool(tool, opts) {
        if (opts?.name) {
          tools.set(opts.name, tool);
        }
      },
    }),
  );

  function requireFactory(name: XaiBilledToolName) {
    const factory = tools.get(name);
    if (typeof factory !== "function") {
      throw new Error(`Expected ${name} to register a tool factory`);
    }
    return factory;
  }

  return {
    code_execution: requireFactory("code_execution"),
    x_search: requireFactory("x_search"),
  };
}

function createXaiBilledToolConfig(name: XaiBilledToolName, enabled?: boolean) {
  const toolConfig = enabled === undefined ? {} : { enabled };
  return {
    plugins: {
      entries: {
        xai: {
          config:
            name === "code_execution" ? { codeExecution: toolConfig } : { xSearch: toolConfig },
        },
      },
    },
  };
}

function mockXaiRuntimeOAuth() {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
    apiKey: "xai-oauth-token",
    mode: "oauth",
    source: "profile:xai-profile",
    profileId: "xai-profile",
  });
}

function stubXaiFetch(respond: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return await respond(url);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function findXaiFetchInit(
  fetchMock: ReturnType<typeof stubXaiFetch>,
  url: string,
): RequestInit | undefined {
  return fetchMock.mock.calls.find(([input]) => input === url)?.[1];
}

async function runXaiCatalog(options: { auth?: "none"; apiKey?: false } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    config: { models: {} },
    agentDir: "/agent",
    workspaceDir: "/workspace",
    env: {},
    resolveProviderAuth: () =>
      options.auth === "none"
        ? { apiKey: undefined, discoveryApiKey: undefined, mode: "none", source: "none" }
        : {
            apiKey: undefined,
            discoveryApiKey: "stale-oauth-token",
            mode: "oauth",
            source: "profile",
            profileId: "xai-profile",
          },
    resolveProviderApiKey: () => ({
      apiKey: options.apiKey === false ? undefined : "env-xai-key",
      discoveryApiKey: options.apiKey === false ? undefined : "env-xai-key",
    }),
  });
  if (!result || !("provider" in result)) {
    throw new Error("expected xAI catalog provider result");
  }
  return { provider, result: result.provider };
}

describe("xai provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
    vi.stubEnv("XAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("exposes xAI OAuth and preserves the explicit device-code alias", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key", "oauth", "device-code"]);
    const oauth = provider.auth?.find((method) => method.id === "oauth");
    expect(oauth?.kind).toBe("oauth");
    expect(oauth?.wizard?.choiceId).toBe("xai-oauth");
    const deviceCode = provider.auth?.find((method) => method.id === "device-code");
    expect(deviceCode?.kind).toBe("device_code");
    expect(deviceCode?.wizard?.choiceId).toBe("xai-device-code");
    expect(deviceCode?.wizard?.assistantVisibility).toBe("manual-only");
    expect(manifest.providerAuthChoices).toContainEqual(
      expect.objectContaining({
        assistantVisibility: "manual-only",
        choiceId: "xai-device-code",
        method: "device-code",
      }),
    );
  });

  it("filters the xAI API-key catalog against live model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          { id: "grok-4.6", object: "model" },
          { id: "grok-4.5", object: "model" },
          { id: "grok-4.20-0309-reasoning", object: "model" },
          { id: "grok-4.20-0309-non-reasoning", object: "model" },
          { id: "not-in-manifest", object: "model" },
        ],
      }),
      finalUrl: "https://api.x.ai/v1/models",
      release,
    }));

    const provider = await buildLiveXaiProvider({
      apiKey: "xai-key",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("xai-key");
    expect(provider.models.map((model) => model.id)).toContain("grok-4.6");
    expect(provider.models.map((model) => model.id)).toContain("grok-4.5");
    expect(provider.models.map((model) => model.id)).toContain("grok-4.20-0309-reasoning");
    expect(provider.models.map((model) => model.id)).toContain("grok-4.20-0309-non-reasoning");
    expect(provider.models.map((model) => model.id)).not.toContain("not-in-manifest");
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe("https://api.x.ai/v1/models");
    const init = fetchParams?.init;
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe("Bearer xai-key");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the Grok OAuth proxy catalog for xAI OAuth discovery", async () => {
    mockXaiRuntimeOAuth();
    const fetchMock = stubXaiFetch((url) => {
      if (url.endsWith("/settings")) {
        return Response.json({ default_model: "grok-build" });
      }
      return Response.json({
        data: [
          {
            id: "grok-composer-2.5-fast",
            model: "grok-composer-2.5-fast",
            name: "Composer 2.5",
            api_backend: "responses",
            context_window: 200_000,
          },
          {
            id: "grok-build",
            model: "grok-build",
            name: "Grok Build",
            api_backend: "responses",
            context_window: 512_000,
          },
          {
            id: "grok-imagine-image",
            model: "grok-imagine-image",
            name: "Grok Imagine",
            api_backend: "image",
          },
        ],
      });
    });
    const { provider, result } = await runXaiCatalog();

    expect(result.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.auth).toBe("oauth");
    expect(result.apiKey).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual([
      "auto",
      "grok-composer-2.5-fast",
      "grok-build",
    ]);
    const auto = result.models.find((model) => model.id === "auto");
    expect(auto?.params?.canonicalModelId).toBe("grok-build");
    const normalizedAuto = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "auto",
      model: { ...auto, provider: "xai" },
    } as never);
    expect(normalizedAuto?.id).toBe("grok-build");
    const composer = result.models.find((model) => model.id === "grok-composer-2.5-fast");
    if (!composer) {
      throw new Error("expected OAuth Composer model");
    }
    expect(composer.reasoning).toBe(true);
    expect(result.models.find((model) => model.id === "grok-build")?.reasoning).toBe(true);
    const normalizedComposer = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: composer.id,
      model: { ...composer, provider: "xai" },
    } as never);
    if (!normalizedComposer) {
      throw new Error("expected normalized OAuth Composer model");
    }
    const capture = createXaiPayloadCaptureStream();
    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: normalizedComposer.id,
      extraParams: {},
      streamFn: capture.streamFn,
    } as never);
    if (!wrapped) {
      throw new Error("expected xAI stream wrapper");
    }
    void wrapped(normalizedComposer as never, { messages: [] } as never, {});
    expect(capture.getCapturedPayload()).not.toHaveProperty("reasoning");
    expect(capture.getCapturedPayload()?.include).toEqual(["reasoning.encrypted_content"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "xai-profile",
      lockedProfile: true,
    });
    const modelFetchInit = findXaiFetchInit(fetchMock, "https://cli-chat-proxy.grok.com/v1/models");
    const settingsFetchInit = findXaiFetchInit(
      fetchMock,
      "https://cli-chat-proxy.grok.com/v1/settings",
    );
    expect(new Headers(modelFetchInit?.headers).get("Authorization")).toBe(
      "Bearer xai-oauth-token",
    );
    expect(new Headers(settingsFetchInit?.headers).get("Authorization")).toBe(
      "Bearer xai-oauth-token",
    );
  });

  it("updates xAI OAuth auto from remote settings without a catalog code change", async () => {
    let remoteDefault = "grok-4-5";
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async ({ url }) => ({
      response: url.endsWith("/settings")
        ? Response.json({ default_model: remoteDefault })
        : Response.json({
            data: [
              { id: "grok-4.5", api_backend: "responses" },
              { id: "grok-next", api_backend: "responses" },
            ],
          }),
      finalUrl: url,
      release,
    }));

    const first = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "xai-oauth-token",
      fetchGuard,
    });
    expect(first.models.find((model) => model.id === "auto")?.params?.canonicalModelId).toBe(
      "grok-4.5",
    );

    clearLiveCatalogCacheForTests();
    remoteDefault = "grok-next";
    const next = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "xai-oauth-token",
      fetchGuard,
    });
    expect(next.models.find((model) => model.id === "auto")?.params?.canonicalModelId).toBe(
      "grok-next",
    );
  });

  it("uses runtime OAuth profiles when xAI catalog auth resolution is empty", async () => {
    mockXaiRuntimeOAuth();
    stubXaiFetch(() =>
      Response.json({
        data: [{ id: "grok-build", model: "grok-build", api_backend: "responses" }],
      }),
    );
    const { result } = await runXaiCatalog({
      auth: "none",
      apiKey: false,
    });

    expect(result.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.auth).toBe("oauth");
    expect(result.models.map((model) => model.id)).toEqual(["auto", "grok-build"]);
    expect(result.models[0]?.params?.canonicalModelId).toBe("grok-build");
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
    });
  });

  it("keeps the Grok OAuth transport when xAI OAuth discovery is unavailable", async () => {
    mockXaiRuntimeOAuth();
    stubXaiFetch(() => new Response("temporarily unavailable", { status: 503 }));
    const { result } = await runXaiCatalog();

    expect(result.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.auth).toBe("oauth");
    expect(result.apiKey).toBeUndefined();
    expect(result.models.map((model) => model.id)).toContain("auto");
    expect(result.models.map((model) => model.id)).toContain("grok-build-0.1");
  });

  it("falls back to API-key discovery when xAI OAuth credential resolution fails", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockRejectedValue(
      new Error("expired oauth profile"),
    );
    const fetchMock = stubXaiFetch(() =>
      Response.json({
        data: [{ id: "grok-4.3", object: "model" }],
      }),
    );
    const { result } = await runXaiCatalog();

    expect(result.baseUrl).toBe("https://api.x.ai/v1");
    expect(result.apiKey).toBe("env-xai-key");
    expect(result.auth).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual(["grok-4.3"]);
    expect(result.models.some((model) => model.id === "auto")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/models");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer env-xai-key",
    );
  });

  it("uses fallback API-key credentials consistently for xAI live discovery", async () => {
    const fetchMock = stubXaiFetch(() =>
      Response.json({
        data: [{ id: "grok-4.3", object: "model" }],
      }),
    );
    const { result } = await runXaiCatalog({ auth: "none" });

    expect(result.apiKey).toBe("env-xai-key");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer env-xai-key",
    );
  });

  it("classifies Grok usage and spending limit errors", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '429 {"code":"Some resource has been exhausted","error":"Rate limit exceeded"}',
      }),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '400 {"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***en. You can obtain an API key from https://console.x.ai."}',
      }),
    ).toBeUndefined();
  });

  it("classifies exhausted Grok credits and subscription requirements as billing", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.classifyFailoverReason?.({
        errorMessage: '403 {"error":"You have run out of credits"}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage: '403 {"error":"You need a Grok subscription"}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage: "403 Forbidden",
      }),
    ).toBeUndefined();
    expect(
      provider.classifyFailoverReason?.({
        errorMessage: "429 Too Many Requests",
      }),
    ).toBe("rate_limit");
  });

  it("registers xAI speech providers for batch and streaming STT", async () => {
    const { mediaProviders, realtimeTranscriptionProviders } = await registerProviderPlugin({
      plugin,
      id: "xai",
      name: "xAI Provider",
    });

    const mediaProvider = requireEntry(mediaProviders, "xai");
    expect(mediaProvider.capabilities).toEqual(["audio"]);
    expect(mediaProvider.defaultModels).toBeUndefined();
    const realtimeProvider = requireEntry(realtimeTranscriptionProviders, "xai");
    expect(realtimeProvider.label).toBe("xAI Realtime Transcription");
    expect(realtimeProvider.aliases).toContain("xai-realtime");
  });

  it("registers xAI realtime voice for Talk gateway-relay", () => {
    const captured = createCapturedPluginRegistration({
      id: "xai",
      name: "xAI Provider",
      source: "test",
    });
    plugin.register(captured.api);
    const realtimeVoiceProvider = requireEntry(captured.realtimeVoiceProviders, "xai");
    expect(realtimeVoiceProvider.label).toBe("xAI Grok Voice");
    expect(realtimeVoiceProvider.aliases).toContain("grok-voice");
    expect(realtimeVoiceProvider.capabilities?.transports).toEqual(["gateway-relay"]);
  });

  it("forwards exact caller cancellation through the registered lazy X search factory", async () => {
    const factory = registerXaiBilledToolFactories().x_search;
    const tool = factory({
      config: createXaiBilledToolConfig("x_search", true),
      activeModel: { provider: "xai" },
      hasAuthForProvider: (providerId) => providerId === "xai",
      resolveApiKeyForProvider: async (providerId) =>
        providerId === "xai" ? "xai-lazy-cancel-key" : undefined,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one registered lazy X search tool");
    }
    expect(tool.resultContentSource).toBe("network");
    const controller = new AbortController();
    const reason = new Error("operator cancelled lazy X search");
    let transportSignal: AbortSignal | undefined;
    const mockFetch = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? undefined;
          transportSignal?.addEventListener("abort", () => reject(reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort(reason));
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      tool.execute("lazy-xai-cancel", { query: "registered lazy cancellation" }, controller.signal),
    ).rejects.toBe(reason);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(transportSignal?.reason).toBe(reason);
  });

  describe.each(["code_execution", "x_search"] as const)("%s exposure", (toolName) => {
    it.each([
      {
        label: "exposes by default for an xAI model with auth",
        provider: "xai",
        hasAuth: true,
        expected: true,
      },
      {
        label: "exposes by default for the shipped xAI provider alias with auth",
        provider: "x-ai",
        hasAuth: true,
        expected: true,
      },
      {
        label: "exposes when explicitly enabled for an xAI model with auth",
        provider: "xai",
        enabled: true,
        hasAuth: true,
        expected: true,
      },
      {
        label: "hides when explicitly disabled for an xAI model",
        provider: "xai",
        enabled: false,
        hasAuth: true,
        expected: false,
      },
      {
        label: "hides by default for a known non-xAI model",
        provider: "openai",
        hasAuth: true,
        expected: false,
      },
      {
        label: "hides when explicitly disabled for a known non-xAI model",
        provider: "openai",
        enabled: false,
        hasAuth: true,
        expected: false,
      },
      {
        label: "exposes when explicitly enabled for a known non-xAI model with auth",
        provider: "openai",
        enabled: true,
        hasAuth: true,
        expected: true,
      },
      {
        label: "hides when the active provider is missing",
        enabled: true,
        hasAuth: true,
        expected: false,
      },
      {
        label: "hides when the active provider is blank",
        provider: "   ",
        enabled: true,
        hasAuth: true,
        expected: false,
      },
      {
        label: "hides an xAI model without auth",
        provider: "xai",
        hasAuth: false,
        expected: false,
      },
      {
        label: "hides an explicit non-xAI opt-in without auth",
        provider: "openai",
        enabled: true,
        hasAuth: false,
        expected: false,
      },
    ])("$label", ({ provider, enabled, hasAuth, expected }) => {
      const factory = registerXaiBilledToolFactories()[toolName];
      const tool = factory({
        config: createXaiBilledToolConfig(toolName, enabled),
        activeModel: provider === undefined ? {} : { provider },
        hasAuthForProvider: (providerId) => hasAuth && providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          hasAuth && providerId === "xai" ? "xai-test-key" : undefined,
      });

      expect(tool).toEqual(expected ? expect.objectContaining({ name: toolName }) : null);
    });

    it.each([
      {
        label: "runtime false overrides source true",
        provider: "xai",
        sourceEnabled: true,
        runtimeEnabled: false,
        expected: false,
      },
      {
        label: "runtime true overrides source false for a known non-xAI provider",
        provider: "openai",
        sourceEnabled: false,
        runtimeEnabled: true,
        expected: true,
      },
    ])("$label", ({ provider, sourceEnabled, runtimeEnabled, expected }) => {
      const factory = registerXaiBilledToolFactories()[toolName];
      const tool = factory({
        config: createXaiBilledToolConfig(toolName, sourceEnabled),
        runtimeConfig: createXaiBilledToolConfig(toolName, runtimeEnabled),
        activeModel: { provider },
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-test-key" : undefined,
      });

      expect(tool).toEqual(expected ? expect.objectContaining({ name: toolName }) : null);
    });
  });

  it("declares setup auto-enable reasons for plugin-owned tool config", () => {
    const probe = registerXaiAutoEnableProbe();

    expect(
      probe({
        config: { plugins: { entries: { xai: { config: { xSearch: { enabled: true } } } } } },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(
      probe({
        config: {
          plugins: { entries: { xai: { config: { codeExecution: { enabled: true } } } } },
        },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(probe({ config: {}, env: {} })).toBeNull();
  });

  it("owns replay policy for xAI OpenAI-compatible transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const completionsPolicy = provider.buildReplayPolicy?.({
      provider: "xai",
      modelApi: "openai-completions",
      modelId: "grok-3",
    } as never);
    expect(completionsPolicy?.sanitizeToolCallIds).toBe(true);
    expect(completionsPolicy?.toolCallIdMode).toBe("strict");
    expect(completionsPolicy?.applyAssistantFirstOrderingFix).toBe(true);
    expect(completionsPolicy?.validateGeminiTurns).toBe(true);
    expect(completionsPolicy?.validateAnthropicTurns).toBe(true);

    const responsesPolicy = provider.buildReplayPolicy?.({
      provider: "xai",
      modelApi: "openai-responses",
      modelId: "grok-4-fast",
    } as never);
    expect(responsesPolicy?.sanitizeToolCallIds).toBe(true);
    expect(responsesPolicy?.toolCallIdMode).toBe("strict");
    expect(responsesPolicy?.applyAssistantFirstOrderingFix).toBe(false);
    expect(responsesPolicy?.validateGeminiTurns).toBe(false);
    expect(responsesPolicy?.validateAnthropicTurns).toBe(false);
  });

  it("wires provider stream shaping for fast mode and tool-stream defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capture = createXaiPayloadCaptureStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: "grok-4",
      extraParams: { fastMode: true },
      streamFn: capture.streamFn,
    } as never);

    runXaiGrok4ResponseStream(wrapped);
    expectXaiFastToolStreamShaping(capture);
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: { fastMode: true },
      } as never),
    ).toEqual({
      fastMode: true,
      tool_stream: true,
    });

    const explicit = { fastMode: true, tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("owns forward-compatible Grok model resolution", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "xai",
      modelId: "grok-4.3",
      modelRegistry: { find: () => null } as never,
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      },
    } as never);
    expect(resolved?.id).toBe("grok-4.3");
    expect(resolved?.provider).toBe("xai");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe("https://api.x.ai/v1");
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
    expect(resolved?.contextWindow).toBe(1_000_000);

    const buildAlias = provider.resolveDynamicModel?.({
      provider: "xai",
      modelId: "grok-build-latest",
      modelRegistry: { find: () => null } as never,
      providerConfig: {
        api: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      },
    } as never);
    expect(buildAlias?.id).toBe("grok-4.5");
    expect(buildAlias?.reasoning).toBe(true);
    expect(buildAlias?.contextWindow).toBe(500_000);
  });

  it("marks modern Grok refs without accepting multi-agent ids", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.6",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.3",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
      } as never),
    ).toBe(false);
  });

  it("owns xai compat flags for direct and downstream routed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "grok-4.3",
      model: createProviderModel({ id: "grok-4.3" }),
    } as never);
    expect(normalized?.id).toBe("grok-4.3");
    expect(normalized?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
    const olderReasoningModel = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "grok-4-1-fast",
      model: createProviderModel({ id: "grok-4-1-fast" }),
    } as never);
    expect(olderReasoningModel?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    });
    const normalizedCompat = normalized?.compat as
      | {
          toolSchemaProfile?: string;
          toolCallArgumentsEncoding?: string;
          unsupportedToolSchemaKeywords?: string[];
        }
      | undefined;
    expect(normalizedCompat?.toolSchemaProfile).toBe("xai");
    expect(normalizedCompat?.toolCallArgumentsEncoding).toBe("html-entities");
    expect(normalizedCompat?.unsupportedToolSchemaKeywords).toEqual(["minContains", "maxContains"]);
  });

  it("preserves Grok 4.6 xhigh reasoning through OAuth auto", async () => {
    mockXaiRuntimeOAuth();
    stubXaiFetch((url) =>
      url.endsWith("/settings")
        ? Response.json({ default_model: "grok-4.6" })
        : Response.json({
            data: [{ id: "grok-4.6", api_backend: "responses" }],
          }),
    );
    const { provider, result } = await runXaiCatalog();
    const auto = result.models.find((model) => model.id === "auto");
    const normalized = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "auto",
      model: { ...auto, provider: "xai" },
    } as never);

    expect(normalized?.id).toBe("grok-4.6");
    expect(normalized?.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(normalized?.compat).toMatchObject({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    });
  });
});
