// Tests provider usage loading from plugin-provided sources.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.fn();
const { envDispatcher, createHttp1EnvHttpProxyAgent, loadUndiciRuntimeDeps, undiciFetch } =
  vi.hoisted(() => {
    const envDispatcherLocal = { dispatch: () => true };
    const undiciFetchLocal = vi.fn();
    const loadUndiciRuntimeDepsLocal = vi.fn(() => ({
      FormData: globalThis.FormData,
      fetch: undiciFetchLocal,
    }));

    return {
      envDispatcher: envDispatcherLocal,
      createHttp1EnvHttpProxyAgent: vi.fn(() => envDispatcherLocal),
      loadUndiciRuntimeDeps: loadUndiciRuntimeDepsLocal,
      undiciFetch: undiciFetchLocal,
    };
  });

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./net/undici-runtime.js", () => ({
  createHttp1EnvHttpProxyAgent,
  loadUndiciRuntimeDeps,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
      resolveProviderUsageSnapshotWithPluginMock(...args),
  };
});

let loadProviderUsageSummary: typeof import("./provider-usage.load.js").loadProviderUsageSummary;

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

function requireFirstPluginUsageCall(): {
  provider?: unknown;
  context?: {
    provider?: unknown;
    token?: unknown;
    authProfileId?: unknown;
    timeoutMs?: unknown;
    fetchFn?: unknown;
  };
} {
  const [call] = resolveProviderUsageSnapshotWithPluginMock.mock.calls;
  if (!call) {
    throw new Error("expected provider usage plugin call");
  }
  const [pluginCall] = call;
  if (!pluginCall || typeof pluginCall !== "object" || Array.isArray(pluginCall)) {
    throw new Error("expected provider usage plugin call");
  }
  return pluginCall as {
    provider?: unknown;
    context?: {
      provider?: unknown;
      token?: unknown;
      authProfileId?: unknown;
      timeoutMs?: unknown;
      fetchFn?: unknown;
    };
  };
}

function requireFetchFn(value: unknown): typeof fetch {
  if (typeof value !== "function") {
    throw new Error("expected provider usage context fetch");
  }
  return value as typeof fetch;
}

function requireUndiciFetchInit(): Record<string, unknown> {
  const init = undiciFetch.mock.calls[0]?.[1];
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected undici fetch init");
  }
  return init as Record<string, unknown>;
}

describe("provider-usage.load plugin boundary", () => {
  beforeAll(async () => {
    ({ loadProviderUsageSummary } = await import("./provider-usage.load.js"));
  });

  beforeEach(() => {
    createHttp1EnvHttpProxyAgent.mockClear();
    loadUndiciRuntimeDeps.mockClear();
    undiciFetch.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
    // Missing proxy mocks must fail locally, not fall through to a provider request.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("unexpected global fetch");
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers plugin-owned usage snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [{ label: "Plugin", usedPercent: 11 }],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "github-copilot", token: "copilot-token" }],
        fetch: mockFetch as unknown as typeof fetch,
        env: {},
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "github-copilot",
          displayName: "Copilot",
          windows: [{ label: "Plugin", usedPercent: 11 }],
        },
      ],
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledOnce();
    const pluginCall = requireFirstPluginUsageCall();
    expect(pluginCall.provider).toBe("github-copilot");
    expect(pluginCall.context?.provider).toBe("github-copilot");
    expect(pluginCall.context?.token).toBe("copilot-token");
    expect(pluginCall.context?.timeoutMs).toBe(5_000);
  });

  it("routes synthetic Codex usage through the Codex hook while preserving OpenAI context", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9 }],
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [
          {
            provider: "openai",
            token: "codex-app-server",
            authProfileId: "openai:work",
            hookProvider: "codex",
          },
        ],
        env: {},
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    const pluginCall = requireFirstPluginUsageCall();
    expect(pluginCall.provider).toBe("codex");
    expect(pluginCall.context?.provider).toBe("openai");
    expect(pluginCall.context?.token).toBe("codex-app-server");
    expect(pluginCall.context?.authProfileId).toBe("openai:work");
  });

  it("passes an env proxy fetch into plugin usage context when no explicit fetch is supplied", async () => {
    const env = { HTTP_PROXY: "", HTTPS_PROXY: "http://proxy.test:8080" };
    undiciFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async (params: unknown) => {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("expected plugin params");
      }
      const context = (params as { context?: { fetchFn?: unknown } }).context;
      await requireFetchFn(context?.fetchFn)("https://chatgpt.com/backend-api/wham/usage");
      return {
        provider: "openai",
        displayName: "Codex",
        windows: [{ label: "5h", usedPercent: 7 }],
      };
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "openai", token: "codex-token", accountId: "acc-1" }],
        env,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "openai",
          displayName: "Codex",
          windows: [{ label: "5h", usedPercent: 7 }],
        },
      ],
    });

    expect(createHttp1EnvHttpProxyAgent).toHaveBeenCalledExactlyOnceWith(
      { httpsProxy: "http://proxy.test:8080" },
      undefined,
      env,
    );
    expect(undiciFetch).toHaveBeenCalledOnce();
    const [input] = undiciFetch.mock.calls[0] ?? [];
    expect(input).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(requireUndiciFetchInit().dispatcher).toBe(envDispatcher);
  });

  it("keeps an explicit fetch ahead of proxy env for plugin usage context", async () => {
    const explicitFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async (params: unknown) => {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("expected plugin params");
      }
      const context = (params as { context?: { fetchFn?: unknown } }).context;
      await requireFetchFn(context?.fetchFn)("https://chatgpt.com/backend-api/wham/usage");
      return {
        provider: "openai",
        displayName: "Codex",
        windows: [{ label: "5h", usedPercent: 9 }],
      };
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "openai", token: "codex-token", accountId: "acc-1" }],
        env: {
          HTTP_PROXY: "",
          HTTPS_PROXY: "http://proxy.test:8080",
        },
        fetch: explicitFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "openai",
          displayName: "Codex",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    expect(explicitFetch).toHaveBeenCalledOnce();
    expect(loadUndiciRuntimeDeps).not.toHaveBeenCalled();
    expect(createHttp1EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});
