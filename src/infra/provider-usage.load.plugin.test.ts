// Tests provider usage loading from plugin-provided sources.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.fn();
const resolveProviderUsageAuthWithPluginMock = vi.fn();
const listProviderUsagePluginDescriptorsMock = vi.fn();
const { EnvHttpProxyAgent, envAgentSpy, loadUndiciRuntimeDeps, undiciFetch } = vi.hoisted(() => {
  const envAgentSpyLocal = vi.fn();
  const undiciFetchLocal = vi.fn();
  class EnvHttpProxyAgentLocal {
    static lastCreated: EnvHttpProxyAgentLocal | undefined;

    constructor(public readonly options?: Record<string, unknown>) {
      EnvHttpProxyAgentLocal.lastCreated = this;
      envAgentSpyLocal(options);
    }
  }
  const loadUndiciRuntimeDepsLocal = vi.fn(() => ({
    EnvHttpProxyAgent: EnvHttpProxyAgentLocal,
    FormData: globalThis.FormData,
    fetch: undiciFetchLocal,
  }));

  return {
    EnvHttpProxyAgent: EnvHttpProxyAgentLocal,
    envAgentSpy: envAgentSpyLocal,
    loadUndiciRuntimeDeps: loadUndiciRuntimeDepsLocal,
    undiciFetch: undiciFetchLocal,
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./net/undici-runtime.js", () => ({
  loadUndiciRuntimeDeps,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    listProviderUsagePluginDescriptors: (...args: unknown[]) =>
      listProviderUsagePluginDescriptorsMock(...args),
    resolveProviderUsageAuthWithPlugin: (...args: unknown[]) =>
      resolveProviderUsageAuthWithPluginMock(...args),
    resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
      resolveProviderUsageSnapshotWithPluginMock(...args),
  };
});

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
  beforeEach(async () => {
    envAgentSpy.mockClear();
    loadUndiciRuntimeDeps.mockClear();
    undiciFetch.mockReset();
    EnvHttpProxyAgent.lastCreated = undefined;
    listProviderUsagePluginDescriptorsMock.mockReset();
    listProviderUsagePluginDescriptorsMock.mockReturnValue([]);
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(undefined);
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
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

  it("auto-discovers plugin-owned usage providers and routes auth + snapshot hooks", async () => {
    listProviderUsagePluginDescriptorsMock.mockReturnValueOnce([
      {
        provider: "kimi",
        displayName: "Kimi",
      },
    ]);
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "resolved-kimi-token",
    });
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "kimi",
      displayName: "Kimi",
      windows: [
        { label: "5h", usedPercent: 12 },
        { label: "7d", usedPercent: 34 },
      ],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("usage plugin mock should receive the fetch function without calling it");
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        env: {
          KIMI_API_KEY: "env-kimi-token",
        },
        fetch: mockFetch as unknown as typeof fetch,
        skipPluginAuthWithoutCredentialSource: true,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "kimi",
          displayName: "Kimi",
          windows: [
            { label: "5h", usedPercent: 12 },
            { label: "7d", usedPercent: 34 },
          ],
        },
      ],
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledOnce();
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledOnce();
    const pluginCall = requireFirstPluginUsageCall();
    expect(pluginCall.provider).toBe("kimi");
    expect(pluginCall.context?.provider).toBe("kimi");
    expect(pluginCall.context?.token).toBe("resolved-kimi-token");
    expect(pluginCall.context?.timeoutMs).toBe(5_000);
    expect(pluginCall.context?.fetchFn).toEqual(expect.any(Function));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("respects plugin-owned handled skips without falling back to usage polling", async () => {
    listProviderUsagePluginDescriptorsMock.mockReturnValueOnce([
      {
        provider: "kimi",
        displayName: "Kimi",
      },
    ]);
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({ handled: true });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("custom Kimi usage proxy should not be polled");
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        env: { KIMI_API_KEY: "kimi-token" },
        fetch: mockFetch as unknown as typeof fetch,
        skipPluginAuthWithoutCredentialSource: true,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [],
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledOnce();
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("passes an env proxy fetch into plugin usage context when no explicit fetch is supplied", async () => {
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
        env: {
          HTTP_PROXY: "",
          HTTPS_PROXY: "http://proxy.test:8080",
        },
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

    expect(envAgentSpy).toHaveBeenCalledOnce();
    expect(envAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ httpsProxy: "http://proxy.test:8080" }),
    );
    expect(undiciFetch).toHaveBeenCalledOnce();
    const [input] = undiciFetch.mock.calls[0] ?? [];
    expect(input).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(requireUndiciFetchInit().dispatcher).toBe(EnvHttpProxyAgent.lastCreated);
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
    expect(envAgentSpy).not.toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});
