// Copilot BYOK proxy tests verify SDK-local transport is guarded outbound fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotByokProxy } from "./byok-proxy.js";
import { resolveCopilotProvider } from "./provider-bridge.js";

const ssrfRuntimeMock = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: ssrfRuntimeMock.fetchWithSsrFGuard,
}));

describe("createCopilotByokProxy", () => {
  afterEach(() => {
    ssrfRuntimeMock.fetchWithSsrFGuard.mockReset();
  });

  it("presents a loopback SDK endpoint and forwards through guarded fetch", async () => {
    const release = vi.fn(async () => undefined);
    ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("ok", {
        status: 201,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "x-upstream": "yes",
        },
      }),
      release,
    });
    const resolvedProvider = resolveCopilotProvider({
      model: {
        provider: "custom-proxy",
        api: "openai-responses",
        id: "proxy-model",
        baseUrl: "https://proxy.example/v1?routing=blue",
      },
      resolvedApiKey: "secret-key",
    });

    const proxy = await createCopilotByokProxy(resolvedProvider);
    expect(proxy?.provider.provider?.baseUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}\/v1$/,
    );

    try {
      const response = await fetch(`${proxy?.provider.provider?.baseUrl}/responses?trace=request`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "proxy-model" }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(await response.text()).toBe("ok");
      expect(ssrfRuntimeMock.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          auditContext: "copilot-byok-provider",
          requireHttps: true,
          url: "https://proxy.example/v1/responses?routing=blue&trace=request",
          init: expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "accept-encoding": "identity",
              authorization: "Bearer secret-key",
              "content-type": "application/json",
            }),
            signal: expect.any(AbortSignal),
          }),
        }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await proxy?.close();
    }
  });

  it("injects resolved bearer auth when the SDK request omits Authorization", async () => {
    ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      release: vi.fn(async () => undefined),
    });
    const resolvedProvider = resolveCopilotProvider({
      model: {
        provider: "tencent-tokenplan",
        api: "openai-completions",
        id: "hy3",
        baseUrl: "https://tokenplan.example/v1",
        authHeader: true,
      },
      resolvedApiKey: "tokenplan-secret",
    });

    const proxy = await createCopilotByokProxy(resolvedProvider);

    try {
      const response = await fetch(`${proxy?.provider.provider?.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "hy3" }),
      });

      expect(response.status).toBe(200);
      expect(ssrfRuntimeMock.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://tokenplan.example/v1/chat/completions",
          init: expect.objectContaining({
            headers: expect.objectContaining({
              authorization: "Bearer tokenplan-secret",
              "content-type": "application/json",
            }),
          }),
        }),
      );
    } finally {
      await proxy?.close();
    }
  });

  it("aborts in-flight upstream fetches when the proxy closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    ssrfRuntimeMock.fetchWithSsrFGuard.mockImplementation(async ({ init }: any) => {
      upstreamSignal = init.signal;
      await new Promise((_, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new Error("upstream aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    });
    const resolvedProvider = resolveCopilotProvider({
      model: {
        provider: "custom-proxy",
        api: "openai-responses",
        id: "proxy-model",
        baseUrl: "https://proxy.example/v1",
      },
    });
    const proxy = await createCopilotByokProxy(resolvedProvider);

    const responsePromise = fetch(`${proxy?.provider.provider?.baseUrl}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "proxy-model" }),
    }).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(upstreamSignal).toBeDefined();
    });

    await proxy?.close();

    expect(upstreamSignal?.aborted).toBe(true);
    await responsePromise;
  });

  it("accepts Azure SDK paths that are rebuilt from the proxy origin", async () => {
    ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("azure-ok", { status: 200 }),
      release: vi.fn(async () => undefined),
    });
    const resolvedProvider = resolveCopilotProvider({
      model: {
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      },
      resolvedApiKey: "azure-key",
    });

    const proxy = await createCopilotByokProxy(resolvedProvider);
    expect(proxy?.provider.provider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    try {
      const response = await fetch(
        `${proxy?.provider.provider?.baseUrl}/openai/v1/responses?trace=request`,
        {
          method: "POST",
          headers: { "api-key": "azure-key" },
          body: JSON.stringify({ model: "deployment-gpt" }),
        },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("azure-ok");
      expect(ssrfRuntimeMock.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          requireHttps: true,
          url: "https://example.openai.azure.com/openai/v1/responses?trace=request",
          init: expect.objectContaining({
            headers: expect.objectContaining({
              "accept-encoding": "identity",
              "api-key": "azure-key",
            }),
          }),
        }),
      );
    } finally {
      await proxy?.close();
    }
  });

  it("does not inject bearer auth on nonce-less Azure SDK paths", async () => {
    ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("azure-ok", { status: 200 }),
      release: vi.fn(async () => undefined),
    });
    const resolvedProvider = resolveCopilotProvider({
      model: {
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        authHeader: true,
      },
      resolvedApiKey: "azure-bearer",
    });

    const proxy = await createCopilotByokProxy(resolvedProvider);

    try {
      const response = await fetch(`${proxy?.provider.provider?.baseUrl}/openai/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "deployment-gpt" }),
      });

      expect(response.status).toBe(200);
      const call = ssrfRuntimeMock.fetchWithSsrFGuard.mock.calls[0]?.[0] as
        | { init?: { headers?: Record<string, string> } }
        | undefined;
      expect(call?.init?.headers).not.toHaveProperty("authorization");
    } finally {
      await proxy?.close();
    }
  });
});
