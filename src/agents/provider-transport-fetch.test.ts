// Verifies guarded provider fetch wiring, stream cleanup, proxy, and local service behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Stream } from "openai/streaming";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

type ProviderRequestPolicyConfigMockResult = {
  allowPrivateNetwork: boolean;
  privateNetworkExplicitlyDenied?: boolean;
  policy?: {
    endpointClass?: string;
  };
};

const {
  buildProviderRequestDispatcherPolicyMock,
  fetchWithSsrFGuardMock,
  ensureModelProviderLocalServiceMock,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
  managedStreamCleanupRegistrations,
} = vi.hoisted(() => {
  // Mock FinalizationRegistry so stream cleanup registrations are directly assertable.
  const managedStreamCleanupRegistrationsLocal: Array<{
    callback: (held: { finalize: () => Promise<void> }) => void;
    held: { finalize: () => Promise<void> };
    token: object;
  }> = [];

  class MockFinalizationRegistry {
    constructor(private callback: (held: { finalize: () => Promise<void> }) => void) {}

    register(_target: object, held: { finalize: () => Promise<void> }, token?: object) {
      managedStreamCleanupRegistrationsLocal.push({
        callback: this.callback,
        held,
        token: token ?? {},
      });
    }

    unregister(token: object) {
      const index = managedStreamCleanupRegistrationsLocal.findIndex(
        (entry) => entry.token === token,
      );
      if (index >= 0) {
        managedStreamCleanupRegistrationsLocal.splice(index, 1);
      }
    }
  }

  vi.stubGlobal("FinalizationRegistry", MockFinalizationRegistry);

  return {
    buildProviderRequestDispatcherPolicyMock: vi.fn<
      (_request?: unknown) => { mode: "direct" } | undefined
    >(() => undefined),
    fetchWithSsrFGuardMock: vi.fn(),
    ensureModelProviderLocalServiceMock: vi.fn(),
    mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
      ...current,
      ...overrides,
    })),
    resolveProviderRequestPolicyConfigMock: vi.fn<() => ProviderRequestPolicyConfigMockResult>(
      () => ({
        allowPrivateNetwork: false,
      }),
    ),
    shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
    withTrustedEnvProxyGuardedFetchModeMock: vi.fn((params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    })),
    managedStreamCleanupRegistrations: managedStreamCleanupRegistrationsLocal,
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: withTrustedEnvProxyGuardedFetchModeMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
}));

vi.mock("./provider-local-service.js", () => ({
  ensureModelProviderLocalService: ensureModelProviderLocalServiceMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: buildProviderRequestDispatcherPolicyMock,
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfig: resolveProviderRequestPolicyConfigMock,
}));

function latestGuardedFetchParams(): Record<string, unknown> {
  // All transport calls should pass through the SSRF-guarded fetch seam.
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return params;
}

function latestTrustedEnvProxyParams(): Record<string, unknown> {
  const calls = withTrustedEnvProxyGuardedFetchModeMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected trusted env proxy call");
  }
  return params;
}

function responseStreamText(text: string): ReadableStream<Uint8Array> {
  return responseStreamChunks([text]);
}

function responseStreamChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function openResponseStreamText(text: string): {
  close: () => void;
  stream: ReadableStream<Uint8Array>;
} {
  // Leaves the stream open so cleanup/finalization paths can be exercised.
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    close() {
      streamController?.close();
    },
    stream: new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(text));
      },
    }),
  };
}

describe("buildGuardedModelFetch", () => {
  beforeEach(() => {
    managedStreamCleanupRegistrations.length = 0;
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    ensureModelProviderLocalServiceMock.mockReset().mockResolvedValue(undefined);
    buildProviderRequestDispatcherPolicyMock.mockClear().mockReturnValue(undefined);
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock
      .mockClear()
      .mockReturnValue({ allowPrivateNetwork: false });
    shouldUseEnvHttpProxyForUrlMock.mockClear().mockReturnValue(false);
    withTrustedEnvProxyGuardedFetchModeMock.mockClear();
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  function sentinelModel(): Model<"openai-responses"> {
    return {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;
  }

  it("swaps sentinels in Request-form headers", async () => {
    const sentinel = mintSecretSentinel("request-form-secret", { label: "request-form" });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${sentinel}` },
    });

    const response = await buildGuardedModelFetch(sentinelModel())(request);
    await response.text();

    const headers = new Headers((latestGuardedFetchParams().init as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer request-form-secret");
  });

  it("swaps sentinels in record init headers", async () => {
    const recordSentinel = mintSecretSentinel("record-header-secret", { label: "record-header" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: { "x-api-key": recordSentinel },
      },
    );
    await response.text();
    expect(
      new Headers((latestGuardedFetchParams().init as RequestInit).headers).get("x-api-key"),
    ).toBe("record-header-secret");
    expect(
      new Headers(ensureModelProviderLocalServiceMock.mock.calls[0]?.[1] as HeadersInit).get(
        "x-api-key",
      ),
    ).toBe(recordSentinel);
  });

  it("swaps sentinels in tuple init headers", async () => {
    const tupleSentinel = mintSecretSentinel("tuple-header-secret", { label: "tuple-header" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: [["x-api-key", tupleSentinel]],
      },
    );
    await response.text();
    expect(
      new Headers((latestGuardedFetchParams().init as RequestInit).headers).get("x-api-key"),
    ).toBe("tuple-header-secret");
  });

  it("swaps sentinels in Headers init and composed Cloudflare auth values", async () => {
    const sentinel = mintSecretSentinel("cloudflare-upstream-secret", { label: "cloudflare" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: new Headers({ "cf-aig-authorization": `Bearer ${sentinel}` }),
      },
    );
    await response.text();

    const headers = new Headers((latestGuardedFetchParams().init as RequestInit).headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-upstream-secret");
  });

  it("swaps sentinels in URL query parameters", async () => {
    const sentinel = mintSecretSentinel("gemini&scope=two+#%", { label: "gemini-query" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      `https://api.openai.com/v1/responses?key=${sentinel}`,
    );
    await response.text();

    expect(latestGuardedFetchParams().url).toBe(
      "https://api.openai.com/v1/responses?key=gemini%26scope%3Dtwo%2B%23%25",
    );
  });

  it("rejects unknown sentinel-shaped values before guarded fetch", async () => {
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    await expect(
      buildGuardedModelFetch(sentinelModel())("https://api.openai.com/v1/responses", {
        headers: { Authorization: `Bearer ${unknown}` },
      }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to send request`,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("keeps the no-sentinel fast path request init untouched", async () => {
    const init: RequestInit = { headers: { Authorization: "Bearer plain-env-key" } };
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      init,
    );
    await response.text();
    expect(latestGuardedFetchParams().init).toStrictEqual(init);
  });

  it("pushes provider capture metadata into the shared guarded fetch seam", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });

    const params = latestGuardedFetchParams();
    expect(params.url).toBe("https://api.openai.com/v1/responses");
    expect(params.capture).toEqual({
      meta: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
      },
    });
  });

  it("rejects successful streamed OpenAI-compatible responses with HTML content", async () => {
    const release = vi.fn(async () => undefined);
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("<html>not the API</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      finalUrl: "https://proxy.example.com/chat/completions",
      release,
    });

    let error: unknown;
    try {
      await buildGuardedModelFetch(model)("https://proxy.example.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "private-model", stream: true }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      code: "invalid_provider_content_type",
      errorType: "invalid_response",
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/baseUrl.*\/v1 path prefix/);
    expect(release).toHaveBeenCalled();
  });

  it("allows missing content-type when streamed OpenAI-compatible responses contain SSE", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText('data: {"ok": true}\n\ndata: [DONE]\n\n')),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("returns promptly for missing content-type SSE streams that remain open", async () => {
    const source = openResponseStreamText('data: {"ok": true}\n\n');
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(source.stream),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const responsePromise = buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const timeout = Symbol("timeout");
    const result = await Promise.race<Response | typeof timeout>([
      responsePromise,
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 100);
      }),
    ]);
    source.close();

    expect(result).not.toBe(timeout);
    const response = result as Response;
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("allows missing content-type when the SSE prefix is split across chunks", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamChunks(["d", "ata", ': {"ok": true}\n\n'])),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("synthesizes SSE for missing content-type JSON returned to streaming SDK requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText('{"ok": true}')),
      finalUrl: "https://chatgpt.com/backend-api/codex/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openclaw-openai-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("rejects missing content-type streamed OpenAI-compatible responses with HTML bodies", async () => {
    const release = vi.fn(async () => undefined);
    const model = {
      id: "private-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com",
    } as unknown as Model<"openai-completions">;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(responseStreamText("<html>not the API</html>")),
      finalUrl: "https://proxy.example.com/chat/completions",
      release,
    });

    await expect(
      buildGuardedModelFetch(model)("https://proxy.example.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "private-model", stream: true }),
      }),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      code: "invalid_provider_content_type",
      errorType: "invalid_response",
    });
    expect(release).toHaveBeenCalled();
  });

  it("ensures configured local services before the model request", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases guarded fetch slots when streamed bodies are abandoned", async () => {
    const release = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("chunk-1"));
            controller.enqueue(encoder.encode("chunk-2"));
          },
        }),
        { status: 200 },
      ),
      finalUrl: "https://api.anthropic.com/v1/messages",
      release,
    });
    const model = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    } as unknown as Model<"anthropic-messages">;

    const fetcher = buildGuardedModelFetch(model, undefined, { sanitizeSse: false });
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"stream":true}',
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();
    expect(firstChunk?.done).toBe(false);
    const registration = managedStreamCleanupRegistrations.at(-1);
    expect(registration).toBeDefined();
    await registration?.held.finalize();

    expect(release).toHaveBeenCalledTimes(1);
    expect(managedStreamCleanupRegistrations).toHaveLength(0);
  });

  it("passes model request headers to local service health probes", async () => {
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;
    const headers = {
      Authorization: "Bearer health-secret",
      "X-Tenant": "acme",
    };

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
      headers,
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, headers, undefined);
  });

  it("passes model request abort signals to local service startup", async () => {
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;
    const controller = new AbortController();

    const fetcher = buildGuardedModelFetch(model);
    const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
    });
    await response.text();

    expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
      model,
      undefined,
      controller.signal,
    );
  });

  it("passes model request timeouts to local service startup", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, 750);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(750);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        timeoutController.signal,
      );
      const params = latestGuardedFetchParams();
      expect(params.timeoutMs).toBe(750);
      expect(params.signal).toBeUndefined();
      expect((params.init as RequestInit | undefined)?.signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("caps oversized model request timeouts before arming abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, Number.MAX_SAFE_INTEGER);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        timeoutController.signal,
      );
      expect(latestGuardedFetchParams().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("ignores non-positive model request timeout metadata", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
      requestTimeoutMs: -1,
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
      });
      await response.text();

      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(model, undefined, undefined);
      expect(latestGuardedFetchParams().timeoutMs).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("combines caller abort signals with model request timeouts", async () => {
    const callerController = new AbortController();
    const timeoutController = new AbortController();
    const combinedController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedController.signal);
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    try {
      const fetcher = buildGuardedModelFetch(model, 750);
      const response = await fetcher("http://127.0.0.1:18000/v1/chat/completions", {
        method: "POST",
        signal: callerController.signal,
      });
      await response.text();

      expect(timeoutSpy).toHaveBeenCalledWith(750);
      expect(anySpy).toHaveBeenCalledWith([callerController.signal, timeoutController.signal]);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        model,
        undefined,
        combinedController.signal,
      );
      const params = latestGuardedFetchParams();
      expect(params.signal).toBe(callerController.signal);
      expect((params.init as RequestInit | undefined)?.signal).toBe(callerController.signal);
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it("releases local service leases when guarded fetch fails", async () => {
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("network down"));
    const model = {
      id: "deepseek-v4-flash",
      provider: "ds4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18000/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);

    await expect(
      fetcher("http://127.0.0.1:18000/v1/chat/completions", { method: "POST" }),
    ).rejects.toThrow("network down");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("scopes fake-IP DNS exemptions to the configured provider host", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    const policy = latestGuardedFetchParams().policy as Record<string, unknown> | undefined;
    expect(policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });
    expect(policy?.allowedHostnames).toBeUndefined();
    expect(policy?.allowPrivateNetwork).toBeUndefined();
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("does not apply fake-IP exemptions to non-provider hosts", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://uploads.openai.com/v1/files", { method: "POST" });

    const policy = latestGuardedFetchParams().policy;
    expect(policy).toBeUndefined();
  });

  it("trusts exact configured custom provider hosts without broad private-network opt-in", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://10.0.0.5:1234"],
    });
    expect(policy?.allowPrivateNetwork).toBeUndefined();
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("trusts exact configured HTTPS custom provider origins", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "custom-vllm",
      api: "openai-completions",
      baseUrl: "https://10.0.0.5:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["https://10.0.0.5:1234"],
    });
  });

  it("keeps explicit private-network denial ahead of configured custom origin trust", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      privateNetworkExplicitlyDenied: true,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("trusts exact configured local provider origins", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "local" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://127.0.0.1:1234"],
    });
  });

  it("does not trust a configured provider host on a different port", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:4321/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("does not add exact-origin trust for non-custom provider endpoints", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "openai-public" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "http://10.0.0.5:1234/v1",
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:1234/v1/chat/completions", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it.each([
    {
      label: "link-local metadata IP",
      baseUrl: "http://169.254.169.254/v1",
      requestUrl: "http://169.254.169.254/v1/chat/completions",
    },
    {
      label: "legacy link-local metadata IP",
      baseUrl: "http://2852039166/v1",
      requestUrl: "http://2852039166/v1/chat/completions",
    },
    {
      label: "embedded IPv6 link-local metadata IP",
      baseUrl: "http://[64:ff9b::a9fe:a9fe]/v1",
      requestUrl: "http://[64:ff9b::a9fe:a9fe]/v1/chat/completions",
    },
    {
      label: "non-link-local cloud metadata IP",
      baseUrl: "http://100.100.100.200/v1",
      requestUrl: "http://100.100.100.200/v1/chat/completions",
    },
    {
      label: "IPv6 cloud metadata IP",
      baseUrl: "http://[fd00:ec2::254]/v1",
      requestUrl: "http://[fd00:ec2::254]/v1/chat/completions",
    },
    {
      label: "embedded IPv6 cloud metadata IP",
      baseUrl: "http://[64:ff9b::6464:64c8]/v1",
      requestUrl: "http://[64:ff9b::6464:64c8]/v1/chat/completions",
    },
    {
      label: "metadata hostname",
      baseUrl: "http://metadata.google.internal/v1",
      requestUrl: "http://metadata.google.internal/v1/chat/completions",
    },
    {
      label: "metadata short hostname",
      baseUrl: "http://metadata/v1",
      requestUrl: "http://metadata/v1/chat/completions",
    },
    {
      label: "metadata compound hostname",
      baseUrl: "http://metadata-server.example/v1",
      requestUrl: "http://metadata-server.example/v1/chat/completions",
    },
    {
      label: "cloud instance-data hostname",
      baseUrl: "http://instance-data.ec2.internal/v1",
      requestUrl: "http://instance-data.ec2.internal/v1/chat/completions",
    },
  ])("does not add implicit exact-origin trust for $label", async (entry) => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: false,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "custom-metadata",
      api: "openai-completions",
      baseUrl: entry.baseUrl,
    } as unknown as Model<"openai-completions">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher(entry.requestUrl, { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("merges explicit private-network opt-in into the provider-host policies", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({
      allowPrivateNetwork: true,
      policy: { endpointClass: "custom" },
    });
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://10.0.0.5:11434",
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:11434/api/chat", { method: "POST" });

    const policy = latestGuardedFetchParams().policy;
    expect(policy).toEqual({
      allowedOrigins: ["http://10.0.0.5:11434"],
      allowPrivateNetwork: true,
    });
  });

  it("uses trusted env-proxy mode for provider calls when no explicit dispatcher policy is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(shouldUseEnvHttpProxyForUrlMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
    );
    const trustedParams = latestTrustedEnvProxyParams();
    expect(trustedParams.url).toBe("https://api.openai.com/v1/responses");
    expect(trustedParams.dispatcherPolicy).toBeUndefined();
    expect(trustedParams.policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });

    const guardedParams = latestGuardedFetchParams();
    expect(guardedParams.url).toBe("https://api.openai.com/v1/responses");
    expect(guardedParams.mode).toBe("trusted_env_proxy");
  });

  it("keeps explicit provider dispatcher policies in strict guarded-fetch mode", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(withTrustedEnvProxyGuardedFetchModeMock).not.toHaveBeenCalled();
    expect(latestGuardedFetchParams().dispatcherPolicy).toEqual({ mode: "direct" });
  });

  it("threads explicit transport timeouts into the shared guarded fetch seam", async () => {
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model, 123_456);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(latestGuardedFetchParams().timeoutMs).toBe(123_456);
  });

  it("threads resolved provider timeout metadata into the shared guarded fetch seam", async () => {
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });

    expect(latestGuardedFetchParams().timeoutMs).toBe(300_000);
  });

  it("does not force explicit debug proxy overrides onto plain HTTP model transports", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_URL = "http://127.0.0.1:7799";
    const model = {
      id: "kimi-k2.5:cloud",
      provider: "ollama",
      api: "ollama-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
    } as unknown as Model<"ollama-chat">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[]}',
    });

    expect(mergeModelProviderRequestOverridesMock).toHaveBeenCalledWith(undefined, {
      proxy: undefined,
    });
  });

  it("drops event-only SSE frames before the OpenAI SDK stream parser sees them", async () => {
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)("https://openrouter.ai/api/v1/responses", {
      method: "POST",
    });
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("leaves official OpenAI SSE streams unmodified", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: response.created\n\ndata: {"ok": true}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });

    await expect(response.text()).resolves.toBe(
      'event: response.created\n\ndata: {"ok": true}\n\n',
    );
  });

  it("drops whitespace-only SSE data frames with CRLF delimiters", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: message\r\ndata:   \r\n\r\ndata: {"ok": true}\r\n\r\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("continues reading until split SSE frames produce a parser-visible event", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encoder.encode("event: response.created\n"));
              return;
            }
            if (pulls === 2) {
              controller.enqueue(encoder.encode('data: {"ok"'));
              return;
            }
            if (pulls === 3) {
              controller.enqueue(encoder.encode(": true}\n\n"));
              return;
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("handles a large transport chunk containing many valid small SSE events", async () => {
    // Regression: one TCP read can deliver >64 KiB of already-delimited SSE
    // events; the cap must apply only to the unterminated tail, not the full chunk.
    const eventCount = 5_000;
    const manyEvents = `data: ${JSON.stringify({ ok: true })}\n\n`.repeat(eventCount);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(manyEvents, {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items: unknown[] = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }
    expect(items.length).toBe(eventCount);
    expect(items[0]).toEqual({ ok: true });
  });

  it("synthesizes SSE frames for JSON bodies returned to streaming OpenAI SDK requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('  {"ok": true}  ', {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("does not re-prefix SSE bodies mislabeled as JSON by streaming gateways", async () => {
    const source = openResponseStreamText(
      'data: {"id":"a","choices":[{"index":0,"delta":{"content":"Hi","role":"assistant"}}]}\n\n' +
        'data: {"id":"a","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n' +
        "data: [DONE]\n\n",
    );
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        source.stream,
        // Mislabeled: SSE body served with a JSON content-type.
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
      finalUrl: "https://gateway.example/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "MiniMax-M3",
      provider: "hetu",
      api: "openai-completions",
      baseUrl: "https://gateway.example/v1",
    } as unknown as Model<"openai-completions">;

    const responsePromise = buildGuardedModelFetch(model)(
      "https://gateway.example/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "MiniMax-M3", stream: true }),
      },
    );
    const timeout = Symbol("timeout");
    const result = await Promise.race<Response | typeof timeout>([
      responsePromise,
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 100);
      }),
    ]);
    source.close();

    expect(result).not.toBe(timeout);
    const response = result as Response;
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }
    expect(items).toEqual([
      { id: "a", choices: [{ index: 0, delta: { content: "Hi", role: "assistant" } }] },
      { id: "a", choices: [{ index: 0, delta: { content: " there" } }] },
    ]);
  });

  it("does not clone Request bodies while checking for streaming JSON fallbacks", async () => {
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
    });

    const response = await buildGuardedModelFetch(model)(request);

    expect(cloneSpy).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("continues reading split JSON bodies before synthesizing streaming SSE frames", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encoder.encode('{"ok"'));
              return;
            }
            if (pulls === 2) {
              controller.enqueue(encoder.encode(": true}"));
              return;
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(items).toEqual([{ ok: true }]);
  });

  it("preserves JSON bodies when the request is not streaming", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"ok": true}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: false }),
      },
    );

    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("preserves non-OK SSE bodies for provider HTTP error parsing", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          error: {
            message: "API key expired",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "text/event-stream" },
        },
      ),
      finalUrl:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gemini-3.1-pro-preview",
      provider: "google",
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "API key expired" },
    });
  });

  it("refreshes the guarded timeout while consuming streaming response chunks", async () => {
    const encoder = new TextEncoder();
    const refreshTimeout = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
      refreshTimeout,
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
    expect(refreshTimeout).toHaveBeenCalledTimes(2);
  });

  it("handles a valid large SSE event split before its boundary", async () => {
    const payload = { text: "x".repeat(70 * 1024) };
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}`));
            controller.enqueue(encoder.encode("\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([payload]);
  });

  it("errors on oversized SSE body without event boundary in sanitizer", async () => {
    const oversized = "x".repeat(16 * 1024 * 1024 + 1024);
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(oversized));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );

    const reader = response.body?.getReader();
    let caught: unknown = null;
    try {
      while (true) {
        const { done } = await reader!.read();
        if (done) {
          break;
        }
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/exceeded max buffer size/i);
  });

  it("errors on oversized streaming JSON body without content-length in SSE synthesis", async () => {
    const CHUNK = 1024 * 1024;
    let sends = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            if (sends < 17) {
              sends++;
              controller.enqueue(new Uint8Array(CHUNK));
            } else {
              controller.close();
            }
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", stream: true }),
      },
    );

    const reader = response.body?.getReader();
    let caught: unknown = null;
    try {
      while (true) {
        const { done } = await reader!.read();
        if (done) {
          break;
        }
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/exceeded.*bytes while synthesizing SSE/i);
  });

  it("caps non-OK response body lazily so SDK can still cancel retryable responses", async () => {
    // Regression: a 429/5xx non-OK body used to be returned unchanged by the
    // shared sanitizer, so a hostile endpoint could OOM the SDK when it called
    // response.text(). The cap is applied lazily via TransformStream so the SDK
    // can still cancel the response before reading any body.
    const OVER_LIMIT = 100 * 1024;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(OVER_LIMIT));
            controller.close();
          },
        }),
        { status: 429, statusText: "Too Many Requests" },
      ),
      finalUrl: "https://custom-azure.openai.azure.com/openai/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "azure",
      api: "azure-openai-responses",
      baseUrl: "https://custom-azure.openai.azure.com/openai/v1",
    } as unknown as Model<"azure-openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );

    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);

    const text = await response.text();
    expect(text.length).toBeLessThanOrEqual(64 * 1024);
    expect(text.length).toBeLessThan(OVER_LIMIT);
  });

  it("returns a capped body before guarded cleanup finishes", async () => {
    const OVER_LIMIT = 100 * 1024;
    let finishRelease!: () => void;
    const releasePending = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(() => releasePending);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(new Uint8Array(OVER_LIMIT), {
        status: 429,
        statusText: "Too Many Requests",
      }),
      finalUrl: "https://custom-azure.openai.azure.com/openai/v1/responses",
      release,
    });
    const model = {
      id: "gpt-5.5",
      provider: "azure",
      api: "azure-openai-responses",
      baseUrl: "https://custom-azure.openai.azure.com/openai/v1",
    } as unknown as Model<"azure-openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );
    const timeout = Symbol("timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      response.text(),
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeout), 100);
      }),
    ]);
    clearTimeout(timeoutHandle);
    finishRelease();

    expect(result).not.toBe(timeout);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves SDK ability to cancel retryable non-OK responses before reading body", async () => {
    // Regression: a non-OK body wrapper must be lazy. The OpenAI SDK may decide
    // to cancel a 429/5xx response and retry before reading the body. If the
    // wrapper eagerly reads the body, the SDK loses that capability.
    const TOTAL_BYTES = 80 * 1024;
    let bytesPulled = 0;
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          pull(controller) {
            if (bytesPulled < TOTAL_BYTES) {
              const chunk = new Uint8Array(8 * 1024);
              bytesPulled += chunk.byteLength;
              controller.enqueue(chunk);
            } else {
              controller.close();
            }
          },
        }),
        { status: 503, statusText: "Service Unavailable" },
      ),
      finalUrl: "https://custom-azure.openai.azure.com/openai/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = {
      id: "gpt-5.5",
      provider: "azure",
      api: "azure-openai-responses",
      baseUrl: "https://custom-azure.openai.azure.com/openai/v1",
    } as unknown as Model<"azure-openai-responses">;

    const response = await buildGuardedModelFetch(model)(
      "https://custom-azure.openai.azure.com/openai/v1/responses",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    // SDK cancels the response body before reading anything. The lazy cap must
    // not pull the full body from the source — a small pre-buffered chunk is
    // allowed (ReadableStream default high-water-mark), but the full payload
    // must remain unconsumed so the SDK can still retry.
    await response.body?.cancel();
    expect(bytesPulled).toBeLessThan(TOTAL_BYTES);
  });

  describe("long retry-after handling", () => {
    const anthropicModel = {
      id: "sonnet-4.6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
    } as unknown as Model<"anthropic-messages">;

    const openaiModel = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    it("injects x-should-retry:false when a retryable response exceeds the default wait cap", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("239");
      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses retry-after-ms from OpenAI-compatible responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after-ms": "90000" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores partial retry-after numeric headers", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "90000ms", "retry-after": "120 seconds" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("bypasses unsafe retry-after-ms numeric headers", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "9007199254740993" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("falls back to retry-after when retry-after-ms is blank", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after-ms": "   ", "retry-after": "120" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses HTTP-date retry-after values", async () => {
      const future = new Date(Date.now() + 120_000).toUTCString();
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": future },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    function formatObsoleteHttpDates(date: Date): Array<[string, string]> {
      const dayNames = [
        ["Sun", "Sunday"],
        ["Mon", "Monday"],
        ["Tue", "Tuesday"],
        ["Wed", "Wednesday"],
        ["Thu", "Thursday"],
        ["Fri", "Friday"],
        ["Sat", "Saturday"],
      ] as const;
      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ] as const;
      const [shortDay, longDay] = dayNames[date.getUTCDay()] ?? dayNames[0];
      const month = monthNames[date.getUTCMonth()] ?? monthNames[0];
      const day = String(date.getUTCDate()).padStart(2, "0");
      const shortYear = String(date.getUTCFullYear() % 100).padStart(2, "0");
      const hours = String(date.getUTCHours()).padStart(2, "0");
      const minutes = String(date.getUTCMinutes()).padStart(2, "0");
      const seconds = String(date.getUTCSeconds()).padStart(2, "0");
      const time = `${hours}:${minutes}:${seconds}`;
      return [
        ["RFC 850", `${longDay}, ${day}-${month}-${shortYear} ${time} GMT`],
        [
          "asctime",
          `${shortDay} ${month} ${day.padStart(2, " ")} ${time} ${date.getUTCFullYear()}`,
        ],
      ];
    }

    it.each([...formatObsoleteHttpDates(new Date(Date.now() + 120_000))])(
      "parses obsolete HTTP-date retry-after values: %s",
      async (_label, retryAfter) => {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 503,
            headers: { "retry-after": retryAfter },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBe("false");
      },
    );

    it("ignores invalid obsolete asctime retry-after values", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": "Sun Nov 99 99:99:99 9999" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each([
      "Sun, 31 Feb 2027 00:00:00 GMT",
      "Sunday, 31-Feb-27 00:00:00 GMT",
      "Mon, 06 Nov 1994 08:49:37 GMT",
      "Monday, 06-Nov-94 08:49:37 GMT",
    ])("ignores invalid HTTP-date retry-after values: %s", async (retryAfter) => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": retryAfter },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("interprets RFC 850 retry-after years within the 50-year future window", async () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T00:00:00.000Z"));
      try {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 503,
            headers: { "retry-after": "Sunday, 06-Nov-50 00:00:00 GMT" },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBe("false");
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("respects OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "10";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores partial OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "10s";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each(["0x10", "1e3"])(
      "ignores non-decimal OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values: %s",
      async (value) => {
        process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = value;
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 429,
            headers: { "retry-after": "30" },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBeNull();
      },
    );

    it("ignores unsafe OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS values", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "9007199254740993";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("injects x-should-retry:false for terminal 429 responses without retry-after", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response("Sorry, you've exceeded your weekly rate limit.", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://api.individual.githubcopilot.com/responses",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.individual.githubcopilot.com/responses",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      await expect(response.text()).resolves.toContain("weekly rate limit");
    });

    it("keeps short retry-after 429 responses retryable", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("can be disabled with OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=0", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "0";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("leaves short retry-after values untouched", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it.each(["soon", "1.5", "0x10", "9007199254740993"])(
      "treats malformed 429 retry-after values as terminal: %s",
      async (retryAfter) => {
        fetchWithSsrFGuardMock.mockResolvedValue({
          response: new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
          finalUrl: "https://api.anthropic.com/v1/messages",
          release: vi.fn(async () => undefined),
        });
        const response = await buildGuardedModelFetch(anthropicModel)(
          "https://api.anthropic.com/v1/messages",
          { method: "POST" },
        );

        expect(response.headers.get("x-should-retry")).toBe("false");
      },
    );

    it("ignores retry-after on non-retryable responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 400,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });
  });
});
