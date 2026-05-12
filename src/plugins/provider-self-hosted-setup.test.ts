import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
} from "./provider-self-hosted-setup.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

const { fetchWithSsrFGuardMock, upsertAuthProfileWithLock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(async () => null),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createContext(params: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}): ProviderAuthMethodNonInteractiveContext {
  const resolved = {
    key: params.apiKey ?? "self-hosted-test-key",
    source: "flag" as const,
  };
  return {
    authChoice: params.providerId,
    config: { agents: { defaults: {} } },
    baseConfig: { agents: { defaults: {} } },
    opts: {
      customBaseUrl: params.baseUrl,
      customApiKey: params.apiKey,
      customModelId: params.modelId,
    },
    runtime: createRuntime() as never,
    agentDir: "/tmp/openclaw-self-hosted-test-agent",
    resolveApiKey: vi.fn<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>(
      async () => resolved,
    ),
    toApiKeyCredential: vi.fn<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>(
      ({ provider, resolved: apiKeyResult }) => ({
        type: "api_key",
        provider,
        key: apiKeyResult.key,
      }),
    ),
  };
}

function readPrimaryModel(config: Awaited<ReturnType<typeof configureSelfHostedTestProvider>>) {
  const model = config?.agents?.defaults?.model;
  return model && typeof model === "object" ? model.primary : undefined;
}

async function configureSelfHostedTestProvider(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  envVar: string;
}) {
  return await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: params.ctx,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    defaultApiKeyEnvVar: params.envVar,
    modelPlaceholder: "Qwen/Qwen3-32B",
  });
}

describe("discoverOpenAICompatibleLocalModels", () => {
  it("uses guarded fetch pinned to the configured self-hosted provider", async () => {
    const release = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("{}", { status: 404 }),
      finalUrl: "http://127.0.0.1:8000/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKey: "self-hosted-test-key",
      label: "vLLM",
      env: {},
    });

    expect(models).toEqual([
      {
        id: "Qwen/Qwen3-32B",
        name: "Qwen/Qwen3-32B",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(1, {
      url: "http://127.0.0.1:8000/v1/models",
      init: { headers: { Authorization: "Bearer self-hosted-test-key" } },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 5000,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(2, {
      url: "http://127.0.0.1:8000/props",
      init: { headers: { Authorization: "Bearer self-hosted-test-key" } },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 2500,
    });
    expect(release).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("uses llama.cpp nested /props n_ctx as the runtime context cap", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-mxfp4-moe",
              meta: { n_ctx_train: 262_144 },
            },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65_536 } }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toEqual([
      {
        id: "qwen3.6-mxfp4-moe",
        name: "qwen3.6-mxfp4-moe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        contextTokens: 65_536,
        maxTokens: 8192,
      },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(2, {
      url: "http://127.0.0.1:8080/props",
      init: { headers: undefined },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 2500,
    });
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("scopes llama.cpp /props runtime caps to each discovered model without autoloading", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const firstPropsRelease = vi.fn(async () => undefined);
    const secondPropsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/router-a",
              meta: { n_ctx_train: 262_144 },
            },
            {
              id: "qwen/router-b",
              meta: { n_ctx_train: 131_072 },
            },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65_536 } }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false",
      release: firstPropsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32_768 } }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false",
      release: secondPropsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toEqual([
      {
        id: "qwen/router-a",
        name: "qwen/router-a",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        contextTokens: 65_536,
        maxTokens: 8192,
      },
      {
        id: "qwen/router-b",
        name: "qwen/router-b",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        contextTokens: 32_768,
        maxTokens: 8192,
      },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(2, {
      url: "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false",
      init: { headers: undefined },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 2500,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(3, {
      url: "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false",
      init: { headers: undefined },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 2500,
    });
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(firstPropsRelease).toHaveBeenCalledOnce();
    expect(secondPropsRelease).toHaveBeenCalledOnce();
  });

  it("keeps top-level llama.cpp /props n_ctx as a compatibility fallback", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-mxfp4-moe",
              meta: { n_ctx_train: 262_144 },
            },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ n_ctx: 65_536 }), { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toEqual([
      {
        id: "qwen3.6-mxfp4-moe",
        name: "qwen3.6-mxfp4-moe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        contextTokens: 65_536,
        maxTokens: 8192,
      },
    ]);
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("preserves explicit configured context windows ahead of llama.cpp /props", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [{ id: "qwen3.6-mxfp4-moe", meta: { n_ctx_train: 262_144 } }],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      contextWindow: 65_536,
      env: {},
    });

    expect(models).toEqual([
      {
        id: "qwen3.6-mxfp4-moe",
        name: "qwen3.6-mxfp4-moe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 8192,
      },
    ]);
    expect(models[0]).not.toHaveProperty("contextTokens");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not allowlist always-blocked metadata hostnames", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "metadata-probe" }] }), {
        status: 200,
      }),
      finalUrl: "http://metadata.google.internal/v1/models",
      release,
    });

    await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://metadata.google.internal/v1",
      label: "vLLM",
      env: {},
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "http://metadata.google.internal/v1/models",
      init: { headers: undefined },
      policy: undefined,
      timeoutMs: 5000,
    });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("configureOpenAICompatibleSelfHostedProviderNonInteractive", () => {
  it.each([
    {
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
      baseUrl: "http://127.0.0.1:8100/v1/",
      apiKey: "vllm-test-key",
      modelId: "Qwen/Qwen3-8B",
    },
    {
      providerId: "sglang",
      providerLabel: "SGLang",
      envVar: "SGLANG_API_KEY",
      baseUrl: "http://127.0.0.1:31000/v1",
      apiKey: "sglang-test-key",
      modelId: "Qwen/Qwen3-32B",
    },
  ])("configures $providerLabel config and auth profile", async (params) => {
    const ctx = createContext(params);

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: params.providerId,
      providerLabel: params.providerLabel,
      envVar: params.envVar,
    });

    const profileId = `${params.providerId}:default`;
    expect(cfg?.auth?.profiles?.[profileId]).toEqual({
      provider: params.providerId,
      mode: "api_key",
    });
    expect(cfg?.models?.providers?.[params.providerId]).toEqual({
      baseUrl: params.baseUrl.replace(/\/+$/, ""),
      api: "openai-completions",
      apiKey: params.envVar,
      models: [
        {
          id: params.modelId,
          name: params.modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${params.modelId}`);
    expect(ctx.resolveApiKey).toHaveBeenCalledWith({
      provider: params.providerId,
      flagValue: params.apiKey,
      flagName: "--custom-api-key",
      envVar: params.envVar,
      envVarName: params.envVar,
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId,
      agentDir: ctx.agentDir,
      credential: {
        type: "api_key",
        provider: params.providerId,
        key: params.apiKey,
      },
    });
  });

  it("exits without touching auth when custom model id is missing", async () => {
    const ctx = createContext({
      providerId: "vllm",
      apiKey: "vllm-test-key",
    });

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
    });

    expect(cfg).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        "Missing --custom-model-id for --auth-choice vllm.",
        "Pass the vLLM model id to use, for example Qwen/Qwen3-32B.",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
  });
});
