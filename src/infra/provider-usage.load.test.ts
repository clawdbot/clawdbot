// Covers provider usage summary loading across auth and plugin paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageAuthWithPluginMock,
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import {
  loadUsageWithAuth,
  type ProviderUsageAuth,
  usageNow,
} from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

type ProviderAuth = ProviderUsageAuth<typeof loadProviderUsageSummary>;
const googleGeminiCliProvider = "google-gemini-cli" as unknown as ProviderAuth["provider"];
const resolveProviderUsageAuthWithPluginMock = getProviderUsageAuthWithPluginMock();
const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
  });

  it("loads snapshots for copilot gemini codex and Xiaomi providers", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "github-copilot":
            return {
              provider,
              displayName: "GitHub Copilot",
              windows: [{ label: "Chat", usedPercent: 20 }],
            };
          case googleGeminiCliProvider:
            return {
              provider,
              displayName: "Gemini CLI",
              windows: [{ label: "Pro", usedPercent: 40 }],
            };
          case "openai":
            return {
              provider,
              displayName: "Codex",
              windows: [{ label: "3h", usedPercent: 12 }],
            };
          case "xiaomi":
            return {
              provider,
              displayName: "Xiaomi",
              windows: [],
            };
          case "xiaomi-token-plan":
            return {
              provider,
              displayName: "Xiaomi Token Plan",
              windows: [{ label: "Token Plan", usedPercent: 15 }],
            };
          default:
            return null;
        }
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "github-copilot", token: "copilot-token" },
        { provider: googleGeminiCliProvider, token: "gemini-token" },
        { provider: "openai", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
        { provider: "xiaomi-token-plan", token: "xiaomi-token-plan-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      googleGeminiCliProvider,
      "openai",
      "xiaomi",
      "xiaomi-token-plan",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === googleGeminiCliProvider)
        ?.windows[0]?.label,
    ).toBe("Pro");
    expect(
      summary.providers.find((provider) => provider.provider === "openai")?.windows[0]?.label,
    ).toBe("3h");
    expect(summary.providers.find((provider) => provider.provider === "xiaomi")?.windows).toEqual(
      [],
    );
    expect(
      summary.providers.find((provider) => provider.provider === "xiaomi-token-plan")?.windows,
    ).toEqual([{ label: "Token Plan", usedPercent: 15 }]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty provider list when auth resolves to none", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(loadProviderUsageSummary, [], mockFetch);
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
  });

  it.each(["async", "sync"])(
    "keeps login-issued API keys out of provider-only %s candidate resolution",
    async (helper) => {
      const authStore: AuthProfileStore = {
        version: 1,
        order: { openrouter: ["openrouter:login", "openrouter:billing"] },
        profiles: {
          "openrouter:login": {
            type: "api_key",
            provider: "openrouter",
            key: "synthetic-login-key",
            metadata: { authFlow: "oauth-pkce" },
          },
          "openrouter:billing": {
            type: "api_key",
            provider: "openrouter",
            key: "synthetic-billing-key",
          },
        },
      };
      resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ context }) => {
        const token =
          helper === "async"
            ? (await context.resolveApiKeyCandidatesFromConfigAndStore?.())?.[0]
            : context.resolveApiKeyFromConfigAndStore();
        return token ? { token } : undefined;
      });
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ context }) => ({
        provider: "openrouter",
        displayName: "OpenRouter",
        windows: [{ label: context.token, usedPercent: 10 }],
      }));
      const options = {
        authStore,
        config: {
          models: {
            providers: {
              openrouter: {
                apiKey: "openrouter:login",
                baseUrl: "https://openrouter.ai/api/v1",
                models: [],
              },
            },
          },
        },
        env: {},
      };
      const account = await loadProviderUsageSummary({
        ...options,
        authProfile: { provider: "openrouter", profileId: "openrouter:login" },
      });
      const provider = await loadProviderUsageSummary({
        ...options,
        providers: ["openrouter"],
        providerOnly: true,
      });
      expect(account.providers[0]?.windows).toEqual([
        { label: "synthetic-login-key", usedPercent: 10 },
      ]);
      expect(provider.providers[0]?.windows).toEqual([
        { label: "synthetic-billing-key", usedPercent: 10 },
      ]);
      expect(authStore.profiles["openrouter:login"]).toBeDefined();
    },
  );

  it.each(["sync", "async"])(
    "respects selected-profile token expiry through the %s usage helper",
    async (helper) => {
      resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ context }) => {
        const token =
          helper === "sync"
            ? context.resolveApiKeyFromConfigAndStore()
            : (await context.resolveApiKeyCandidatesFromConfigAndStore?.())?.[0];
        return token ? { token } : { handled: true };
      });
      const fetchMock = createProviderUsageFetch(async () => makeResponse(200, "{}"));
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ context }) => {
        await context.fetchFn("https://usage.example.invalid", {
          headers: { Authorization: `Bearer ${context.token}` },
        });
        return { provider: "zai", displayName: "Z.AI", windows: [] };
      });
      const options = {
        authProfile: { provider: "zai", profileId: "zai:saved" },
        authStore: {
          version: 1,
          profiles: {
            "zai:saved": {
              type: "token",
              provider: "zai",
              token: "synthetic-expired-token",
              expires: Date.now() - 60_000,
            },
          },
        },
        config: {},
        env: {},
        fetch: fetchMock,
      } satisfies Parameters<typeof loadProviderUsageSummary>[0];
      const summary = await loadProviderUsageSummary(options);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(summary.providers).toEqual([]);
      options.authStore.profiles["zai:saved"].expires = Date.now() + 60_000;
      await loadProviderUsageSummary(options);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("does not fetch an account fallback for provider-only billing", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "account-token",
      authProfileId: "anthropic:account",
    });
    const summary = await loadProviderUsageSummary({
      providers: ["anthropic"],
      providerOnly: true,
      config: {},
      env: {},
      authStore: {
        version: 1,
        profiles: {
          "anthropic:account": {
            type: "token",
            provider: "anthropic",
            token: "account-token",
          },
        },
      },
    });
    expect(summary.providers).toEqual([]);
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
  });

  it("reports exact-account auth failures without contacting the provider", async () => {
    resolveProviderUsageAuthWithPluginMock.mockRejectedValueOnce(
      new Error("Saved account secret is unavailable"),
    );
    const summary = await loadProviderUsageSummary({
      now: usageNow,
      authProfile: { provider: "openrouter", profileId: "openrouter:account" },
      authStore: { version: 1, profiles: {} },
      config: {},
      env: {},
    });

    expect(summary.providers).toEqual([
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        windows: [],
        error: "Saved account secret is unavailable",
      },
    ]);
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
  });

  it("does not enter the provider hook after profile refresh authority is revoked", async () => {
    let resolveAuth: ((value: { token: string; authProfileId: string }) => void) | undefined;
    const authPending = new Promise<{ token: string; authProfileId: string }>((resolve) => {
      resolveAuth = resolve;
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async () => await authPending);
    let current = true;

    const summaryPending = loadProviderUsageSummary({
      now: usageNow,
      authProfile: { provider: "openai", profileId: "openai:work" },
      authStore: { version: 1, profiles: {} },
      config: {},
      env: {},
      isAuthProfileCurrent: () => current,
    });
    await vi.waitFor(() => expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledOnce());

    current = false;
    resolveAuth?.({ token: "profile-token", authProfileId: "openai:work" });

    await expect(summaryPending).resolves.toEqual({ updatedAt: usageNow, providers: [] });
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
  });

  it("does not let a provider hook send after profile refresh authority is revoked", async () => {
    let releaseHook: (() => void) | undefined;
    const hookBlocked = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({ token: "profile-token" });
    const fetchMock = createProviderUsageFetch(async () => makeResponse(200, "{}"));
    resolveProviderUsageSnapshotWithPluginMock.mockImplementationOnce(async ({ context }) => {
      await hookBlocked;
      await context.fetchFn("https://usage.example.invalid");
      return {
        provider: "openai",
        displayName: "OpenAI",
        windows: [{ label: "5h", usedPercent: 10 }],
      };
    });
    let current = true;
    const summaryPending = loadProviderUsageSummary({
      now: usageNow,
      authProfile: { provider: "openai", profileId: "openai:work" },
      authStore: { version: 1, profiles: {} },
      config: {},
      env: {},
      fetch: fetchMock,
      isAuthProfileCurrent: () => current,
    });
    await vi.waitFor(() =>
      expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledOnce(),
    );

    current = false;
    releaseHook?.();

    await summaryPending;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }] as unknown as ProviderAuth[],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 500",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toStrictEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("keeps balance-only summary snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥42.50",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "deepseek", token: "token-d" }],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "deepseek",
        displayName: "DeepSeek",
        windows: [],
        summary: "Balance ¥42.50",
      },
    ]);
  });

  it("keeps usage summary available when one provider fetch rejects", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        if (provider === "anthropic") {
          throw new Error("fetch failed");
        }
        const usageProvider = provider as ProviderUsageSnapshot["provider"];
        return {
          provider: usageProvider,
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-a" },
        { provider: "openai", token: "token-codex" },
      ],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: "fetch failed",
      },
      {
        provider: "openai",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12 }],
      },
    ]);
  });

  it("returns live siblings at the deadline while retaining the unfinished provider", async () => {
    vi.useFakeTimers();
    const scope = new AsyncWorkScope();
    const heldSnapshot = createDeferredCore<ProviderUsageSnapshot>();
    const lateSnapshot: ProviderUsageSnapshot = {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "5h", usedPercent: 20 }],
    };
    let summaryPromise: Promise<UsageSummary> | undefined;
    let draining: Promise<void> | undefined;
    try {
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => {
        if (provider === "anthropic") {
          return await heldSnapshot.promise;
        }
        return {
          provider,
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      });
      summaryPromise = scope.track(() =>
        loadProviderUsageSummary({
          auth: [
            { provider: "anthropic", token: "token-a" },
            { provider: "openai", token: "token-codex" },
          ],
          config: {},
          env: {},
          timeoutMs: 5_000,
        }),
      );
      let settled = false;
      void summaryPromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const settledAtDeadline = settled;
      if (!settledAtDeadline) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const summary = await summaryPromise;

      expect(settledAtDeadline).toBe(true);
      expect(summary.providers).toEqual([
        { provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" },
        {
          provider: "openai",
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        },
      ]);
      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      heldSnapshot.resolve(lateSnapshot);
      await draining;
      expect(drained).toBe(true);
      expect(summary.providers[0]?.error).toBe("Timeout");
    } finally {
      heldSnapshot.resolve(lateSnapshot);
      await Promise.allSettled([
        summaryPromise,
        ...resolveProviderUsageSnapshotWithPluginMock.mock.results.map((result) => result.value),
      ]);
      await (draining ?? scope.drain());
      vi.useRealTimers();
    }
  });

  it("refreshes every healthy profile across successive batches larger than the queue deadline", async () => {
    vi.useFakeTimers();
    const profileIds = Array.from({ length: 10 }, (_, index) => `openai:${index}`);
    const batches: string[][] = [];
    let active = 0;
    let peakActive = 0;
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue({ token: "profile-token" });
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider, context }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 40);
        });
        return {
          provider,
          displayName: provider,
          windows: [{ label: context.authProfileId ?? "missing profile", usedPercent: 12 }],
        };
      } finally {
        active -= 1;
      }
    });
    try {
      for (let batch = 0; batch < 2; batch += 1) {
        const pending = profileIds.map((profileId) =>
          loadProviderUsageSummary({
            authProfile: { provider: "openai", profileId },
            authStore: { version: 1, profiles: {} },
            config: {},
            env: {},
            timeoutMs: 50,
            isAuthProfileCurrent: () => true,
          }),
        );
        await vi.advanceTimersByTimeAsync(160);
        batches.push(
          (await Promise.all(pending)).map((summary) => {
            const snapshot = summary.providers[0];
            return snapshot?.windows[0]?.label ?? snapshot?.error ?? "missing usage";
          }),
        );
      }
      expect(batches).toEqual([profileIds, profileIds]);
      expect(peakActive).toBe(3);
      expect(active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { releaseAfter: 50, requestsStarted: 4 },
    { releaseAfter: 100, requestsStarted: 3 },
  ])(
    "holds the I/O cap and expires queued work before release at $releaseAfter ms",
    async ({ releaseAfter, requestsStarted }) => {
      vi.useFakeTimers();
      let releaseWork: (() => void) | undefined;
      const workBlocked = new Promise<void>((resolve) => {
        releaseWork = resolve;
      });
      resolveProviderUsageAuthWithPluginMock.mockResolvedValue({ token: "profile-token" });
      resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => {
        await workBlocked;
        return { provider, displayName: provider, windows: [] };
      });
      const pending = Array.from({ length: 4 }, (_, index) =>
        loadProviderUsageSummary({
          authProfile: { provider: "openai", profileId: `openai:${index}` },
          authStore: { version: 1, profiles: {} },
          config: {},
          env: {},
          timeoutMs: 50,
          isAuthProfileCurrent: () => true,
        }),
      );
      let queuedSettled = false;
      void pending[3]?.then(() => {
        queuedSettled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(49);
        await Promise.all(pending.slice(0, 3));
        expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledTimes(3);
        expect(queuedSettled).toBe(false);

        if (releaseAfter === 100) {
          await vi.advanceTimersByTimeAsync(50);
          await expect(pending[3]).resolves.toMatchObject({
            providers: [{ error: "Refresh queue timeout" }],
          });
          expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledTimes(3);
        }
        releaseWork?.();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.all(pending);
        expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledTimes(requestsStarted);
      } finally {
        releaseWork?.();
        await Promise.allSettled(pending);
        vi.useRealTimers();
      }
    },
  );

  it("keeps successful provider usage when a sibling auth hook rejects", async () => {
    resolveProviderUsageAuthWithPluginMock.mockImplementation(async ({ provider }) => {
      if (provider === "anthropic") {
        throw new Error("auth failed");
      }
      return { token: `${provider}-token` };
    });
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(async ({ provider }) => ({
      provider,
      displayName: provider,
      windows: [{ label: "5h", usedPercent: 12 }],
    }));

    const summary = await loadProviderUsageSummary({
      providers: ["anthropic", "openai"],
      config: {},
      // Credential sources keep both providers past the plugin-auth gate so the
      // sibling-isolation behavior under test is actually exercised.
      env: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" },
    });

    expect(summary.providers).toEqual([
      { provider: "anthropic", displayName: "Claude", windows: [], error: "auth failed" },
      {
        provider: "openai",
        displayName: "openai",
        windows: [{ label: "5h", usedPercent: 12 }],
      },
    ]);
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          now: usageNow,
          auth: [{ provider: "xiaomi", token: "token-x" }],
          env: {},
          fetch: undefined,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
