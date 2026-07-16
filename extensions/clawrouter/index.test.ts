import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";
import { wrapClawRouterProviderStream } from "./stream.js";

const LIVE_CATALOG = {
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/openai",
      routes: [],
      models: [
        {
          id: "openai/gpt-5.5",
          upstream: "gpt-5.5",
          capabilities: ["llm.responses"],
        },
      ],
    },
  ],
};

describe("ClawRouter plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers catalog, transport compatibility, and quota hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider).toMatchObject({
      id: "clawrouter",
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      envVars: ["CLAWROUTER_API_KEY"],
      buildReplayPolicy: expect.any(Function),
      fetchUsageSnapshot: expect.any(Function),
      inspectToolSchemas: expect.any(Function),
      normalizeResolvedModel: expect.any(Function),
      normalizeToolSchemas: expect.any(Function),
      prepareDynamicModel: expect.any(Function),
      preferRuntimeResolvedModel: expect.any(Function),
      resolveDynamicModel: expect.any(Function),
      resolveUsageAuth: expect.any(Function),
      sanitizeReplayHistory: expect.any(Function),
      wrapSimpleCompletionStreamFn: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "ClawRouter proxy key",
      kind: "api_key",
    });
    expect(provider?.wrapSimpleCompletionStreamFn).toBe(provider?.wrapStreamFn);
  });

  it("attaches the proxy key and native upstream id only at request dispatch", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const calls: Array<Parameters<StreamFn>[0]> = [];
    const baseStreamFn: StreamFn = (model) => {
      calls.push(model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider?.wrapStreamFn?.({
      provider: "clawrouter",
      modelId: "anthropic/claude-sonnet-4-6",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        provider: "clawrouter",
        api: "anthropic-messages",
        id: "anthropic/claude-sonnet-4-6",
        headers: { "x-request-id": "request-1" },
        params: {
          clawrouterRoute: {
            api: "anthropic-messages",
            baseUrl: "https://clawrouter.example/v1/native/anthropic",
            upstreamModel: "claude-sonnet-4-6",
          },
        },
      } as never,
      {} as never,
      { apiKey: "runtime-proxy-key", requestId: "automatic-call-id" } as never,
    );

    expect(calls[0]?.headers).toEqual({
      "x-request-id": "request-1",
      "X-ClawRouter-Client": "openclaw",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(calls[0]?.id).toBe("claude-sonnet-4-6");
    expect(calls[0]?.params).toBeUndefined();
  });

  it("attaches bounded attribution without overriding configured metadata", () => {
    const calls: Array<Parameters<StreamFn>[0]> = [];
    const baseStreamFn: StreamFn = (model) => {
      calls.push(model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = wrapClawRouterProviderStream({
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      agentId: "main",
      streamFn: baseStreamFn,
    } as never);

    const longRunId = `run-${"r".repeat(300)}`;
    void wrapped?.(
      {
        provider: "clawrouter",
        api: "openai-responses",
        id: "openai/gpt-5.5",
        headers: {
          "x-clawrouter-client": "managed-openclaw",
          "X-ClawRouter-Project-Id": "fakeco",
        },
      } as never,
      {} as never,
      {
        apiKey: "runtime-proxy-key",
        requestId: `${longRunId}:model:1`,
        sessionId: `session-${"x".repeat(300)}`,
      } as never,
    );
    void wrapped?.(
      {
        provider: "clawrouter",
        api: "openai-responses",
        id: "openai/gpt-5.5",
      } as never,
      {} as never,
      {
        requestId: `${longRunId}:model:2`,
      } as never,
    );
    void wrapped?.(
      {
        provider: "clawrouter",
        api: "openai-responses",
        id: "openai/gpt-5.5",
      } as never,
      {} as never,
      {
        requestId: "turn-😀:model:3",
      } as never,
    );

    expect(calls[0]?.headers).toMatchObject({
      "x-clawrouter-client": "managed-openclaw",
      "X-ClawRouter-Agent-Id": "main",
      "X-ClawRouter-Project-Id": "fakeco",
      Authorization: "Bearer runtime-proxy-key",
    });
    expect(calls[0]?.headers?.["X-ClawRouter-Session-Id"]).toHaveLength(256);
    expect(calls[0]?.headers?.["X-Request-ID"]).toHaveLength(128);
    expect(calls[0]?.headers?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:1$/u);
    expect(calls[1]?.headers?.["X-Request-ID"]).toMatch(/~[a-f0-9]{16}:model:2$/u);
    expect(calls[1]?.headers?.["X-Request-ID"]).not.toBe(calls[0]?.headers?.["X-Request-ID"]);
    expect(calls[2]?.headers?.["X-Request-ID"]).toMatch(/^turn-_~[a-f0-9]{16}:model:3$/u);
  });

  it("keeps an explicit per-request header ahead of the automatic model-call id", () => {
    const calls: Array<{
      model: Parameters<StreamFn>[0];
      options: Parameters<StreamFn>[2];
    }> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      calls.push({ model, options });
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = wrapClawRouterProviderStream({
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        provider: "clawrouter",
        api: "openai-responses",
        id: "openai/gpt-5.5",
      } as never,
      {} as never,
      {
        headers: { "x-request-id": "operator-request" },
        requestId: "automatic-call-id",
      } as never,
    );

    expect(calls[0]?.model.headers).not.toHaveProperty("X-Request-ID");
    expect(calls[0]?.options?.headers).toEqual({ "x-request-id": "operator-request" });
  });

  it("omits unsafe attribution header values", () => {
    const calls: Array<Parameters<StreamFn>[0]> = [];
    const baseStreamFn: StreamFn = (model) => {
      calls.push(model);
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = wrapClawRouterProviderStream({
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      agentId: "bad\nagent",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        provider: "clawrouter",
        api: "openai-responses",
        id: "openai/gpt-5.5",
      } as never,
      {} as never,
      {
        apiKey: "runtime-proxy-key",
        requestId: "bad\nrequest",
        sessionId: "bad\rsession",
      } as never,
    );

    expect(calls[0]?.headers).toEqual({
      "X-ClawRouter-Client": "openclaw",
      Authorization: "Bearer runtime-proxy-key",
    });
  });

  it("resolves managed secret refs before scoped discovery", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "resolved-proxy-key",
      mode: "api-key",
      source: "models.json secretref",
    });
    const fetchMock = vi.fn(async () => Response.json(LIVE_CATALOG));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = await registerSingleProviderPlugin(plugin);

    const result = await provider?.catalog?.run({
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      env: {},
      resolveProviderAuth: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "profile",
        profileId: "clawrouter-profile",
      }),
      resolveProviderApiKey: () => ({
        apiKey: "secretref-managed",
        discoveryApiKey: undefined,
      }),
    });

    if (!result || !("provider" in result)) {
      throw new Error("expected ClawRouter catalog provider result");
    }
    expect(result.provider.apiKey).toBe("secretref-managed");
    expect(result.provider.models.map((model) => model.id)).toEqual(["openai/gpt-5.5"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "clawrouter-profile",
      lockedProfile: true,
    });
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(new Headers(fetchCall?.[1]?.headers).get("Authorization")).toBe(
      "Bearer resolved-proxy-key",
    );
  });

  it("surfaces catalog authentication failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider?.catalog?.run({
        config: { models: {} },
        env: { CLAWROUTER_API_KEY: "invalid-proxy-key" },
        resolveProviderAuth: () => ({
          apiKey: "invalid-proxy-key",
          discoveryApiKey: "invalid-proxy-key",
          mode: "api_key",
          source: "env",
        }),
        resolveProviderApiKey: () => ({
          apiKey: "invalid-proxy-key",
          discoveryApiKey: "invalid-proxy-key",
        }),
      }),
    ).rejects.toThrow(/401/u);
  });

  it("resolves configured catalog models through a stored auth profile", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "resolved-proxy-key",
      mode: "api-key",
      source: "auth profile",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(LIVE_CATALOG)),
    );
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      modelRegistry: { find: vi.fn(() => null) },
      authProfileId: "clawrouter-profile",
      authProfileMode: "api_key",
    };

    expect(provider?.resolveDynamicModel?.(context as never)).toBeUndefined();
    expect(provider?.preferRuntimeResolvedModel?.(context as never)).toBe(false);
    await provider?.prepareDynamicModel?.(context as never);

    expect(provider?.preferRuntimeResolvedModel?.(context as never)).toBe(true);
    expect(provider?.resolveDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: "https://clawrouter.openclaw.ai/v1",
      params: {
        clawrouterRoute: {
          api: "openai-responses",
          baseUrl: "https://clawrouter.openclaw.ai/v1",
        },
      },
    });
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "clawrouter",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "clawrouter-profile",
      lockedProfile: true,
    });
    expect(
      provider?.resolveDynamicModel?.({
        ...context,
        authProfileId: "another-profile",
      } as never),
    ).toBeUndefined();

    providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue(undefined);
    await provider?.prepareDynamicModel?.(context as never);
    expect(provider?.preferRuntimeResolvedModel?.(context as never)).toBe(false);
    expect(provider?.resolveDynamicModel?.(context as never)).toBeUndefined();
  });

  it("keeps the previous dynamic model snapshot while rebuilding", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({ apiKey: "decoy-token" })
      .mockResolvedValueOnce({ apiKey: "changeme" });
    let finishRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(LIVE_CATALOG))
      .mockReturnValueOnce(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      modelRegistry: { find: vi.fn(() => null) },
      authProfileId: "clawrouter-profile",
      authProfileMode: "api_key",
    };

    await provider?.prepareDynamicModel?.(context as never);
    const refresh = provider?.prepareDynamicModel?.(context as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(provider?.resolveDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
    });

    finishRefresh?.(Response.json({ providers: [] }));
    await refresh;
    expect(provider?.resolveDynamicModel?.(context as never)).toBeUndefined();
  });

  it("keeps the previous dynamic model snapshot when catalog refresh fails", async () => {
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockResolvedValueOnce({ apiKey: "decoy-token" })
      .mockResolvedValueOnce({ apiKey: "changeme" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(LIVE_CATALOG))
        .mockRejectedValueOnce(new Error("catalog unavailable")),
    );
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      config: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      provider: "clawrouter",
      modelId: "openai/gpt-5.5",
      modelRegistry: { find: vi.fn(() => null) },
      authProfileId: "clawrouter-profile",
      authProfileMode: "api_key",
    };

    await provider?.prepareDynamicModel?.(context as never);
    await expect(provider?.prepareDynamicModel?.(context as never)).rejects.toThrow(
      "catalog unavailable",
    );

    expect(provider?.resolveDynamicModel?.(context as never)).toMatchObject({
      id: "openai/gpt-5.5",
    });
  });

  it("dispatches replay and tool policies by upstream protocol family", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider?.buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "anthropic-messages",
        modelId: "anthropic/claude-sonnet-4-6",
      } as never),
    ).toMatchObject({ preserveNativeAnthropicToolUseIds: true, validateAnthropicTurns: true });
    expect(
      provider?.buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "google-generative-ai",
        modelId: "google/gemini-3.5-flash",
      } as never),
    ).toMatchObject({ validateGeminiTurns: true });
    expect(
      provider?.buildReplayPolicy?.({
        provider: "clawrouter",
        modelApi: "openai-completions",
        modelId: "deepseek/deepseek-v4-flash",
      } as never),
    ).toMatchObject({ sanitizeToolCallIds: true });
  });
});
