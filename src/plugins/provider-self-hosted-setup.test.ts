/** Tests self-hosted provider setup helpers and auth/config defaults. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
} from "./provider-self-hosted-setup.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

const { fetchWithSsrFGuardMock, upsertAuthProfileWithLock, loggerWarnMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(async () => null),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: loggerWarnMock }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Mirrors SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES in the source under test. Kept in
// sync deliberately so the regression asserts the body is capped, not drained.
const SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/**
 * Builds a Response body that would never terminate on its own: each pull emits
 * a 1 MiB chunk forever. A bounded reader must cancel it after the byte cap.
 */
function createUnboundedJsonStream(): {
  body: ReadableStream<Uint8Array>;
  cancelCount: number;
  bytesPulled: number;
} {
  const state = { cancelCount: 0, bytesPulled: 0 };
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20); // ASCII spaces: valid stream, never closes
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelCount += 1;
    },
  });
  return {
    body,
    get cancelCount() {
      return state.cancelCount;
    },
    get bytesPulled() {
      return state.bytesPulled;
    },
  };
}

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

function cancelTrackedResponse(init?: ResponseInit): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

async function discoverSingleCatalogModel(
  row: Record<string, unknown>,
  options?: { contextWindow?: number },
) {
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify({ data: [row] }), { status: 200 }),
    finalUrl: "https://provider.example/v1/models",
    release,
  });

  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl: "https://provider.example/v1",
    label: "custom provider",
    contextWindow: options?.contextWindow,
    discoverRuntimeContext: false,
    env: {},
  });

  expect(release).toHaveBeenCalledOnce();
  return models[0];
}

describe("discoverOpenAICompatibleLocalModels", () => {
  it("retains valid models when a provider catalog contains malformed entries", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            { id: "valid-a", meta: { n_ctx_train: 32_768 } },
            null,
            7,
            "invalid",
            [],
            { id: "valid-b", meta: { n_ctx_train: 65_536 } },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      discoverRuntimeContext: false,
      env: {},
    });

    expect(models).toMatchObject([
      { id: "valid-a", contextWindow: 32_768 },
      { id: "valid-b", contextWindow: 65_536 },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([null, {}, "invalid"])("rejects a non-array model catalog: %j", async (data) => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data }), { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8000/v1",
        label: "vLLM",
        discoverRuntimeContext: false,
        env: {},
      }),
    ).resolves.toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("vLLM discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds concurrent llama.cpp runtime probes without truncating its model catalog", async () => {
    const release = vi.fn(async () => undefined);
    const data = Array.from({ length: 201 }, (_, index) => ({
      id: `local/model-${index}`,
      meta: { n_ctx_train: 32_768 },
    }));
    let activePropsRequests = 0;
    let maximumPropsRequests = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/models")) {
        return {
          response: new Response(JSON.stringify({ data }), { status: 200 }),
          finalUrl: url,
          release,
        };
      }
      activePropsRequests += 1;
      maximumPropsRequests = Math.max(maximumPropsRequests, activePropsRequests);
      await Promise.resolve();
      activePropsRequests -= 1;
      return {
        response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 16_384 } }), {
          status: 200,
        }),
        finalUrl: url,
        release,
      };
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toHaveLength(201);
    expect(models[0]).toMatchObject({ id: "local/model-0", contextTokens: 16_384 });
    expect(models[199]).toMatchObject({ id: "local/model-199", contextTokens: 16_384 });
    expect(models[200]).toMatchObject({ id: "local/model-200", contextWindow: 32_768 });
    expect(models[200]).not.toHaveProperty("contextTokens");
    expect(maximumPropsRequests).toBeLessThanOrEqual(8);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(201);
    expect(release).toHaveBeenCalledTimes(201);
  });

  it("discovers a large non-llama.cpp catalog without probing per-model llama.cpp props", async () => {
    const release = vi.fn(async () => undefined);
    const data = Array.from({ length: 500 }, (_, index) => ({
      id: `Qwen/model-${index}`,
      meta: { n_ctx_train: 32_768 },
    }));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data }), { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      discoverRuntimeContext: false,
      env: {},
    });

    expect(models).toHaveLength(500);
    expect(models[0]).toMatchObject({ id: "Qwen/model-0", contextWindow: 32_768 });
    expect(models[499]).toMatchObject({ id: "Qwen/model-499", contextWindow: 32_768 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("labels malformed discovery JSON in the warning", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("not valid json {", { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "local llama.cpp",
      env: {},
    });

    expect(models).toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local llama.cpp discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("logs a warning when discovery JSON contains invalid UTF-8 bytes", async () => {
    const release = vi.fn(async () => undefined);
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"data":[{"id":"qwen3-'),
      0xff,
      ...new TextEncoder().encode('"}]}'),
    ]);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "local llama.cpp",
      env: {},
    });

    expect(models).toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local llama.cpp discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses guarded fetch pinned to the configured self-hosted provider", async () => {
    const release = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    const propsResponse = cancelTrackedResponse({ status: 404 });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: propsResponse.response,
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
    expect(propsResponse.wasCanceled()).toBe(true);
  });

  it.each([
    ["context_length", 200_000],
    ["context_window", 400_000],
    ["context_size", 1_048_576],
  ] as const)("reads provider-advertised %s", async (field, contextWindow) => {
    const model = await discoverSingleCatalogModel({ id: "custom-model", [field]: contextWindow });

    expect(model).toMatchObject({ id: "custom-model", contextWindow });
  });

  it("keeps explicit and llama.cpp metadata ahead of top-level catalog fields", async () => {
    const row = {
      id: "custom-model",
      meta: { n_ctx_train: 262_144 },
      context_length: 200_000,
      context_window: 100_000,
      context_size: 50_000,
    };

    await expect(discoverSingleCatalogModel(row)).resolves.toMatchObject({
      contextWindow: 262_144,
    });

    await expect(
      discoverSingleCatalogModel(row, { contextWindow: 524_288 }),
    ).resolves.toMatchObject({ contextWindow: 524_288 });
  });

  it("uses a deterministic top-level field priority", async () => {
    const model = await discoverSingleCatalogModel({
      id: "custom-model",
      context_length: 300_000,
      context_window: 200_000,
      context_size: 100_000,
    });

    expect(model).toMatchObject({ contextWindow: 300_000 });
  });

  it.each([0, -1, "1048576", null])(
    "ignores malformed top-level context metadata: %j",
    async (contextSize) => {
      const model = await discoverSingleCatalogModel({
        id: "custom-model",
        context_size: contextSize,
      });

      expect(model).toMatchObject({ contextWindow: 128_000 });
    },
  );

  it("cancels model discovery error bodies before falling back", async () => {
    const release = vi.fn(async () => undefined);
    const response = cancelTrackedResponse({ status: 503, statusText: "Service Unavailable" });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: response.response,
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKey: "self-hosted-test-key",
      label: "vLLM",
      env: {},
    });

    expect(models).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(response.wasCanceled()).toBe(true);
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

  it("bounds an unbounded /models discovery stream instead of buffering it", async () => {
    const release = vi.fn(async () => undefined);
    const oversized = createUnboundedJsonStream();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.body, { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      env: {},
    });

    // The reader cancels the body once the byte cap is exceeded; without the
    // cap the stream would never finish and the discovery would buffer it all.
    expect(models).toEqual([]);
    expect(oversized.cancelCount).toBe(1);
    expect(oversized.bytesPulled).toBeLessThanOrEqual(
      SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES + 2 * CHUNK_BYTES,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded llama.cpp /props discovery stream instead of buffering it", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    const oversized = createUnboundedJsonStream();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "qwen3.6-mxfp4-moe" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.body, { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    // /props overflow is swallowed so discovery still succeeds, but the body is
    // capped: the runtime context token probe is skipped, not OOM'd.
    expect(models).toEqual([
      {
        id: "qwen3.6-mxfp4-moe",
        name: "qwen3.6-mxfp4-moe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ]);
    expect(oversized.cancelCount).toBe(1);
    expect(oversized.bytesPulled).toBeLessThanOrEqual(
      SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES + 2 * CHUNK_BYTES,
    );
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
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
