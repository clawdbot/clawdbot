// Xai tests cover index plugin behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
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
import { buildLiveXaiProvider } from "./provider-catalog.js";
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

describe("xai provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes OAuth and device-code auth choices", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key", "oauth", "device-code"]);
    const deviceCode = provider.auth?.find((method) => method.id === "device-code");
    expect(deviceCode?.kind).toBe("device_code");
    expect(deviceCode?.wizard?.choiceId).toBe("xai-device-code");
  });

  it("filters the xAI API-key catalog against live model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          { id: "grok-4.3", object: "model" },
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
    expect(provider.models.map((model) => model.id)).toContain("grok-4.3");
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
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "xai-oauth-token",
      mode: "oauth",
      source: "profile:xai-profile",
      profileId: "xai-profile",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
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
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: "stale-oauth-token",
        mode: "oauth",
        source: "profile",
        profileId: "xai-profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "env-xai-key",
        discoveryApiKey: "env-xai-key",
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected xAI catalog provider result");
    }
    expect(result.provider.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.provider.auth).toBe("oauth");
    expect(result.provider.apiKey).toBeUndefined();
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "grok-composer-2.5-fast",
      "grok-build",
    ]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "xai-profile",
      lockedProfile: true,
    });
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(fetchCall?.[0]).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(new Headers(fetchCall?.[1]?.headers).get("Authorization")).toBe(
      "Bearer xai-oauth-token",
    );
  });

  it("uses runtime OAuth profiles when xAI catalog auth resolution is empty", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "xai-oauth-token",
      mode: "oauth",
      source: "profile:xai-profile",
      profileId: "xai-profile",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "grok-build", model: "grok-build", api_backend: "responses" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
      resolveProviderApiKey: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected xAI catalog provider result");
    }
    expect(result.provider.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.provider.auth).toBe("oauth");
    expect(result.provider.models.map((model) => model.id)).toEqual(["grok-build"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
    });
  });

  it("keeps the Grok OAuth transport when xAI OAuth discovery is unavailable", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "xai-oauth-token",
      mode: "oauth",
      source: "profile:xai-profile",
      profileId: "xai-profile",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("temporarily unavailable", { status: 503 }),
      ) as unknown as typeof fetch,
    );
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: "stale-oauth-token",
        mode: "oauth",
        source: "profile",
        profileId: "xai-profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "env-xai-key",
        discoveryApiKey: "env-xai-key",
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected xAI catalog provider result");
    }
    expect(result.provider.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.provider.auth).toBe("oauth");
    expect(result.provider.apiKey).toBeUndefined();
    expect(result.provider.models.map((model) => model.id)).toContain("grok-build-0.1");
  });

  it("falls back to API-key discovery when xAI OAuth credential resolution fails", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockRejectedValue(
      new Error("expired oauth profile"),
    );
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "grok-4.3", object: "model" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: "stale-oauth-token",
        mode: "oauth",
        source: "profile",
        profileId: "xai-profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "env-xai-key",
        discoveryApiKey: "env-xai-key",
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected xAI catalog provider result");
    }
    expect(result.provider.baseUrl).toBe("https://api.x.ai/v1");
    expect(result.provider.apiKey).toBe("env-xai-key");
    expect(result.provider.auth).toBeUndefined();
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(fetchCall?.[0]).toBe("https://api.x.ai/v1/models");
    expect(new Headers(fetchCall?.[1]?.headers).get("Authorization")).toBe("Bearer env-xai-key");
  });

  it("uses fallback API-key credentials consistently for xAI live discovery", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "grok-4.3", object: "model" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider.catalog?.run({
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "env-xai-key",
        discoveryApiKey: "env-xai-key",
      }),
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected xAI catalog provider result");
    }
    expect(result.provider.apiKey).toBe("env-xai-key");
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const fetchInit = fetchCall?.[1];
    expect(new Headers(fetchInit?.headers).get("Authorization")).toBe("Bearer env-xai-key");
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

  it("registers xAI speech providers for batch and streaming STT", async () => {
    const { mediaProviders, realtimeTranscriptionProviders } = await registerProviderPlugin({
      plugin,
      id: "xai",
      name: "xAI Provider",
    });

    const mediaProvider = requireEntry(mediaProviders, "xai");
    expect(mediaProvider.capabilities).toEqual(["audio"]);
    expect(mediaProvider.defaultModels).toEqual({ audio: "grok-stt" });
    const realtimeProvider = requireEntry(realtimeTranscriptionProviders, "xai");
    expect(realtimeProvider.label).toBe("xAI Realtime Transcription");
    expect(realtimeProvider.aliases).toContain("xai-realtime");
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
  });

  it("marks modern Grok refs without accepting multi-agent ids", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

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
    expect(normalized?.thinkingLevelMap).toEqual({
      off: null,
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
          nativeWebSearchTool?: boolean;
          toolCallArgumentsEncoding?: string;
        }
      | undefined;
    expect(normalizedCompat?.toolSchemaProfile).toBe("xai");
    expect(normalizedCompat?.nativeWebSearchTool).toBe(true);
    expect(normalizedCompat?.toolCallArgumentsEncoding).toBe("html-entities");
  });
});
