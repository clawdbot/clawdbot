import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
// Kimi Coding tests cover index plugin behavior.
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("kimi provider plugin", () => {
  it("normalizes legacy Kimi Code ids to the stable API model id", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        provider: "kimi",
        modelId: "kimi-code",
        model: {
          id: "kimi-code",
          name: "Kimi Code",
          provider: "kimi",
          api: "anthropic-messages",
        },
      } as never),
    ).toEqual({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      api: "anthropic-messages",
    });

    expect(provider.normalizeModelId?.({ provider: "kimi", modelId: "k3[1m]" } as never)).toBe(
      "k3",
    );
  });

  it("uses binary thinking with thinking off by default", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "kimi-code",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it.each(["k3", "k3-256k"])("exposes %s adaptive thinking levels", async (modelId) => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId,
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("wraps K3 simple completions without changing K2 simple completions", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const streamFn = (() => undefined) as never;

    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "k3",
        streamFn,
      } as never),
    ).not.toBe(streamFn);
    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "kimi-for-coding",
        streamFn,
      } as never),
    ).toBe(streamFn);
  });

  it("resolves Kimi usage auth from existing env and config sources", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.resolveUsageAuth?.({
        config: {} as never,
        env: { KIMI_API_KEY: "env-kimi-key", KIMICODE_API_KEY: "legacy-kimi-key" },
        resolveApiKeyFromConfigAndStore: (options?: {
          providerIds?: string[];
          envDirect?: Array<string | undefined>;
        }) => {
          expect(options?.providerIds).toEqual(["kimi", "kimi-code", "kimi-coding"]);
          expect(options?.envDirect).toEqual(["env-kimi-key", "legacy-kimi-key"]);
          return "resolved-kimi-key";
        },
      } as never),
    ).resolves.toEqual({ token: "resolved-kimi-key" });
  });

  it("skips Kimi usage auth for custom proxy baseUrl", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.resolveUsageAuth?.({
        config: {
          models: {
            providers: {
              kimi: { baseUrl: "https://proxy.example/kimi/v1/" },
            },
          },
        } as never,
        env: { KIMI_API_KEY: "env-kimi-key" },
        resolveApiKeyFromConfigAndStore: () => "resolved-kimi-key",
      } as never),
    ).resolves.toEqual({ handled: true });
  });

  it("fetches Kimi usage windows through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const mockFetch = createProviderUsageFetch(async (url) => {
      expect(url).toBe("https://api.kimi.com/coding/v1/usages");
      return makeResponse(200, {
        usage: { limit: 100, used: 12 },
        limits: [{ name: "5h", detail: { limit: 50, remaining: 45 } }],
      });
    });

    await expect(
      provider.fetchUsageSnapshot?.({
        config: {} as never,
        env: {},
        provider: "kimi",
        token: "kimi-key",
        timeoutMs: 5000,
        fetchFn: mockFetch,
      }),
    ).resolves.toEqual({
      provider: "kimi",
      displayName: "Kimi",
      windows: [
        { label: "5h", usedPercent: 10 },
        { label: "7d", usedPercent: 12 },
      ],
    });
  });

  it("skips usage polling for custom Kimi provider baseUrl", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, {}));

    await expect(
      provider.fetchUsageSnapshot?.({
        config: {
          models: {
            providers: {
              kimi: { baseUrl: "https://proxy.example/kimi/v1/" },
            },
          },
        } as never,
        env: {},
        provider: "kimi",
        token: "kimi-key",
        timeoutMs: 5000,
        fetchFn: mockFetch,
      }),
    ).resolves.toBeNull();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
