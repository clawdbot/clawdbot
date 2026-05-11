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
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
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
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8000/v1/models",
      init: { headers: { Authorization: "Bearer self-hosted-test-key" } },
      policy: {
        hostnameAllowlist: ["127.0.0.1"],
        allowPrivateNetwork: true,
      },
      timeoutMs: 5000,
    });
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
      expect.stringContaining("Missing --custom-model-id for --auth-choice vllm."),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
  });
});
