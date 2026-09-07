import { readFileSync } from "node:fs";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  prepareOpencodeZenModel,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";

const requireRecord = createRequireRecord("record", "expected-label-record");
const METADATA_URL = "https://models.opencode.ai/api.json";
const MODELS_URL = "https://opencode.ai/zen/v1/models";
const OFFLINE_MODEL_IDS = [
  "claude-opus-5",
  "gpt-5.6-sol",
  "gpt-5-nano",
  "gemini-3.6-flash",
  "minimax-m3",
  "kimi-k3",
  "big-pickle",
] as const;

type UpstreamFixtureModel = {
  id: string;
  name?: string;
  npm?: string;
  status?: string;
  reasoningEfforts?: string[];
};

function upstreamCatalog(models: readonly UpstreamFixtureModel[]) {
  return {
    opencode: {
      id: "opencode",
      api: "https://opencode.ai/zen/v1",
      npm: "@ai-sdk/openai-compatible",
      models: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name ?? model.id,
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, input: 900_000, output: 131_072 },
            cost: { input: 0, output: 0, cache_read: 0 },
            ...(model.npm ? { provider: { npm: model.npm } } : {}),
            ...(model.status ? { status: model.status } : {}),
            ...(model.reasoningEfforts
              ? { reasoning_options: [{ type: "effort", values: model.reasoningEfforts }] }
              : {}),
          },
        ]),
      ),
    },
  };
}

function guardedResponse(url: string, body: unknown) {
  return {
    response: new Response(JSON.stringify(body)),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  };
}

function createCatalogFetchGuard(params: {
  metadata: readonly UpstreamFixtureModel[];
  advertised: readonly string[] | ((authorization: string | null) => readonly string[]);
}) {
  return vi.fn(async ({ url, init }: { url: string; init?: RequestInit }) => {
    if (url === METADATA_URL) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return guardedResponse(url, upstreamCatalog(params.metadata));
    }
    if (url === MODELS_URL) {
      const authorization = new Headers(init?.headers).get("authorization");
      const ids =
        typeof params.advertised === "function"
          ? params.advertised(authorization)
          : params.advertised;
      return guardedResponse(url, { data: ids.map((id) => ({ id, object: "model" })) });
    }
    throw new Error(`unexpected discovery URL: ${url}`);
  });
}

function expectSeedModels(models: ReadonlyArray<{ id: string }>) {
  expect(models.map((model) => model.id)).toEqual(OFFLINE_MODEL_IDS);
}

describe("opencode provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers only the Zen auth choice from its own provider manifest", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("opencode");
    expect(provider.envVars).toEqual(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]);
    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["opencode-zen"]);
    expect(provider.auth[0]?.wizard).toMatchObject({
      choiceLabel: "OpenCode Zen catalog",
      groupId: "opencode",
      groupHint: "Shared API key infrastructure for Zen + Go",
    });
  });

  it("registers image media understanding through the OpenCode plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const mediaProvider = mediaProviders.find((provider) => provider.id === "opencode");

    expect(mediaProvider?.capabilities).toEqual(["image"]);
    expect(mediaProvider?.defaultModels).toEqual({ image: "gpt-5-nano" });
    expect(typeof mediaProvider?.describeImage).toBe("function");
  });

  it("owns Gemini-only passthrough replay policy", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "claude-opus-4.6",
    });
  });

  it("keeps the offline manifest seed resolvable without downloading metadata", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.staticCatalog?.run({} as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected registered OpenCode Zen static provider");
    }
    expectSeedModels(result.provider.models);
    // Official public-feed snapshot, 2026-08-30; connected pricing refreshes independently.
    expect(result.provider.models.find((model) => model.id === "gpt-5.6-sol")?.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tieredPricing: [
        { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, range: [0, 272_000] },
        { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5, range: [272_000] },
      ],
    });
    expectSeedModels(manifest.modelCatalog.providers.opencode.models);
    for (const modelId of OFFLINE_MODEL_IDS) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({ id: modelId });
    }
    expect(
      provider.resolveDynamicModel?.({ modelId: "unknown-offline-fixture" } as never),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the documented offline provider families", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const docs = readFileSync("docs/providers/opencode.md", "utf8");
    const exampleRow = docs.match(/^\| Example models\s+\| (?<examples>.+) \|$/m);
    if (!exampleRow?.groups?.examples) {
      throw new Error("expected OpenCode Zen example model row");
    }
    const examples = new Set(
      [...exampleRow.groups.examples.matchAll(/`opencode\/(.*?)`/g)].map((match) => match[1]),
    );

    for (const modelId of OFFLINE_MODEL_IDS.filter((id) => examples.has(id))) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({ id: modelId });
    }
    expect(provider.resolveDynamicModel?.({ modelId: "claude-opus-5" } as never)).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(provider.resolveDynamicModel?.({ modelId: "gpt-5.6-sol" } as never)).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(provider.resolveDynamicModel?.({ modelId: "gemini-3.6-flash" } as never)).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("exposes the offline seed through provider discovery without network access", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const { default: discovery } = await import("./provider-discovery.js");
    const result = await discovery.staticCatalog?.run({} as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Zen static provider");
    }
    expectSeedModels(result.provider.models);
    expect(manifest.modelCatalog.discovery.opencode).toBe("runtime");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never downloads metadata when OpenCode has no configured credentials", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never),
    ).resolves.toBeNull();
    await expect(
      provider.prepareDynamicModel?.({
        config: {},
        provider: "opencode",
        modelId: "unconfigured-preview-fixture",
        modelRegistry: {},
      } as never),
    ).resolves.toBeUndefined();
    await expect(
      provider.prepareDynamicModel?.({
        config: {},
        provider: "opencode",
        modelId: "unconfigured-preview-fixture",
        modelRegistry: {},
        authProfileMode: "api_key",
        authProfileId: "anthropic:default",
      } as never),
    ).resolves.toBeUndefined();
    expectSeedModels((await buildOpencodeZenLiveProviderConfig()).models);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not resolve OpenCode credentials or download metadata for another provider scope", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const resolveProviderApiKey = vi.fn(
      (): { apiKey: string; discoveryApiKey: string | undefined } => ({
        apiKey: "configured-opencode-key",
        discoveryApiKey: "configured-opencode-key",
      }),
    );
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        providerIds: ["anthropic"],
        resolveProviderApiKey,
      } as never),
    ).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveProviderApiKey.mockReturnValueOnce({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: undefined,
    });
    const ownScope = await provider.catalog?.run({
      config: {},
      env: {},
      providerIds: ["opencode"],
      resolveProviderApiKey,
    } as never);
    expect(ownScope).toMatchObject({ provider: { apiKey: NON_ENV_SECRETREF_MARKER } });
    expect(resolveProviderApiKey).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads upstream metadata only after an explicitly selected provider is configured", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            upstreamCatalog([{ id: "configured-selection-fixture", npm: "@ai-sdk/anthropic" }]),
          ),
        ),
      );
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.prepareDynamicModel?.({
        config: { models: { providers: { opencode: { baseUrl: "https://opencode.ai/zen/v1" } } } },
        provider: "opencode",
        modelId: "configured-selection-fixture",
        modelRegistry: {},
      } as never),
    ).resolves.toMatchObject({
      id: "configured-selection-fixture",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(METADATA_URL);
    expect(new Headers(request?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("does not mix provider-specific runtime auth with shared discovery auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(plugin);
    const resolveProviderApiKey = vi.fn((providerId: string) =>
      providerId === "opencode"
        ? { apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: undefined }
        : { apiKey: "shared-opencode-key", discoveryApiKey: "shared-opencode-key" },
    );
    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Zen provider result");
    }
    expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expectSeedModels(result.provider.models);
    expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("opencode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { authProvider: "opencode", apiKey: NON_ENV_SECRETREF_MARKER },
    { authProvider: "opencode-go", apiKey: NON_ENV_SECRETREF_MARKER },
    { authProvider: "opencode", apiKey: undefined },
  ])("keeps $authProvider catalog credentials and profile together ($apiKey)", async (fixture) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const liveCatalog = vi
      .spyOn(await import("./provider-catalog.js"), "buildOpencodeZenLiveProviderConfig")
      .mockImplementation(async (params = {}) => ({
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: params.apiKey,
        models: [],
      }));
    const auth = {
      apiKey: fixture.apiKey,
      discoveryApiKey: "selected-discovery-key",
      profileId: `${fixture.authProvider}:selected`,
      mode: "api_key" as const,
    };
    const resolveProviderApiKey = vi.fn((providerId?: string) => {
      if (providerId === fixture.authProvider) {
        return auth;
      }
      if (providerId === "opencode") {
        return { apiKey: undefined, profileId: "opencode:unconfigured" };
      }
      throw new Error("Unused sibling credentials must not be resolved");
    });

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: auth.apiKey ?? auth.discoveryApiKey,
        models: [],
      },
      outcomes: [{ provider: "opencode", profileId: auth.profileId, status: "ready" }],
    });
    expect(liveCatalog).toHaveBeenCalledExactlyOnceWith({
      apiKey: auth.apiKey ?? auth.discoveryApiKey,
      discoveryApiKey: auth.discoveryApiKey,
    });
    expect(resolveProviderApiKey.mock.calls).toEqual(
      fixture.authProvider === "opencode" ? [["opencode"]] : [["opencode"], ["opencode-go"]],
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["opencode", "opencode-go"])(
    "propagates %s credential lookup failures without selecting another account",
    async (failedProvider) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const failure = new Error("Selected account credentials are unavailable");
      const resolveProviderApiKey = vi.fn((providerId?: string) => {
        if (providerId === failedProvider) {
          throw failure;
        }
        return { apiKey: undefined };
      });

      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          resolveProviderApiKey,
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        }),
      ).rejects.toBe(failure);
      expect(resolveProviderApiKey.mock.calls).toEqual(
        failedProvider === "opencode" ? [["opencode"]] : [["opencode"], ["opencode-go"]],
      );
    },
  );

  it("discovers previously unknown trusted models and their upstream-owned transport", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [
        { id: "x-preview-f-free", name: "Ox Alpha Free", reasoningEfforts: ["low", "high", "max"] },
        { id: "fresh-claude-fixture", npm: "@ai-sdk/anthropic" },
        { id: "fresh-gemini-fixture", npm: "@ai-sdk/google" },
        { id: "fresh-gpt-fixture", npm: "@ai-sdk/openai" },
        { id: "retired-zen-fixture", status: "deprecated" },
      ],
      advertised: [
        "x-preview-f-free",
        "fresh-claude-fixture",
        "fresh-gemini-fixture",
        "fresh-gpt-fixture",
        "retired-zen-fixture",
        "untrusted-live-only-fixture",
      ],
    });
    const provider = await registerSingleProviderPlugin(plugin);
    expect(
      provider.resolveDynamicModel?.({ modelId: "x-preview-f-free" } as never),
    ).toBeUndefined();

    const first = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-key",
      discoveryApiKey: "discovery-key",
      fetchGuard,
    });
    const second = await buildOpencodeZenLiveProviderConfig({
      apiKey: "other-runtime-key",
      discoveryApiKey: "discovery-key",
      fetchGuard,
    });

    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      METADATA_URL,
      MODELS_URL,
    ]);
    expect(first.models.map((model) => model.id)).toEqual([
      "x-preview-f-free",
      "fresh-claude-fixture",
      "fresh-gemini-fixture",
      "fresh-gpt-fixture",
    ]);
    expect(second.apiKey).toBe("other-runtime-key");
    expect(second.models.map((model) => model.id)).toEqual(first.models.map((model) => model.id));
    expect(first.models.find((model) => model.id === "x-preview-f-free")).toMatchObject({
      name: "Ox Alpha Free",
      api: "openai-completions",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 900_000,
      maxTokens: 131_072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportedReasoningEfforts: ["low", "high", "max"] },
    });
    expect(first.models.find((model) => model.id === "fresh-claude-fixture")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(first.models.find((model) => model.id === "fresh-gemini-fixture")).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(first.models.find((model) => model.id === "fresh-gpt-fixture")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(
      provider.resolveDynamicModel?.({ modelId: "retired-zen-fixture" } as never),
    ).toMatchObject({
      id: "retired-zen-fixture",
    });
    expect(
      provider.resolveDynamicModel?.({ modelId: "untrusted-live-only-fixture" } as never),
    ).toBeUndefined();
  });

  it("prepares explicitly selected upstream models without guessing names or protocol", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "selected-provider-fixture", npm: "@ai-sdk/anthropic" }],
      advertised: [],
    });

    await expect(
      prepareOpencodeZenModel({ modelId: "selected-provider-fixture", fetchGuard }),
    ).resolves.toMatchObject({
      id: "selected-provider-fixture",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([METADATA_URL]);
  });

  it("evicts dynamic models removed or rejected by a refreshed authoritative catalog", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "refreshed-model-fixture" }],
      advertised: [],
    });
    await prepareOpencodeZenModel({ modelId: "refreshed-model-fixture", fetchGuard });
    expect(
      provider.resolveDynamicModel?.({ modelId: "refreshed-model-fixture" } as never),
    ).toMatchObject({
      id: "refreshed-model-fixture",
    });

    clearLiveCatalogCacheForTests();
    const removedFetchGuard = createCatalogFetchGuard({ metadata: [], advertised: [] });
    await prepareOpencodeZenModel({
      modelId: "refreshed-model-fixture",
      fetchGuard: removedFetchGuard,
    });
    expect(
      provider.resolveDynamicModel?.({ modelId: "refreshed-model-fixture" } as never),
    ).toBeUndefined();

    clearLiveCatalogCacheForTests();
    await prepareOpencodeZenModel({ modelId: "refreshed-model-fixture", fetchGuard });
    clearLiveCatalogCacheForTests();
    const unsupportedFetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "refreshed-model-fixture", npm: "@untrusted/unknown" }],
      advertised: [],
    });
    await prepareOpencodeZenModel({
      modelId: "refreshed-model-fixture",
      fetchGuard: unsupportedFetchGuard,
    });
    expect(
      provider.resolveDynamicModel?.({ modelId: "refreshed-model-fixture" } as never),
    ).toBeUndefined();
    expect(provider.resolveDynamicModel?.({ modelId: "gpt-5-nano" } as never)).toMatchObject({
      id: "gpt-5-nano",
    });
  });

  it("shares upstream metadata while keeping advertised models scoped to discovery keys", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "account-a-fixture" }, { id: "account-b-fixture" }],
      advertised: (authorization) =>
        authorization === "Bearer discovery-a" ? ["account-a-fixture"] : ["account-b-fixture"],
    });
    const first = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    const second = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-b",
      discoveryApiKey: "discovery-b",
      fetchGuard,
    });

    expect(first.models.map((model) => model.id)).toEqual(["account-a-fixture"]);
    expect(second.models.map((model) => model.id)).toEqual(["account-b-fixture"]);
    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      METADATA_URL,
      MODELS_URL,
      MODELS_URL,
    ]);
  });

  it("reports failed discovery instead of returning the offline seed", async () => {
    const fetchGuard = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(
      buildOpencodeZenLiveProviderConfig({
        apiKey: "runtime-key",
        discoveryApiKey: "discovery-key",
        fetchGuard,
      }),
    ).rejects.toThrow("network unavailable");
  });

  it.each(["failed", "filtered"] as const)(
    "keeps refreshed metadata separate from %s model advertising",
    async (advertising) => {
      const retiredId = "big-pickle";
      const provider = await registerSingleProviderPlugin(plugin);
      const fetchGuard = createCatalogFetchGuard({
        metadata: [{ id: retiredId, status: "deprecated" }],
        advertised: () => {
          if (advertising === "failed") {
            throw new Error("model advertising unavailable");
          }
          return [retiredId];
        },
      });

      try {
        expectSeedModels((await buildOpencodeZenLiveProviderConfig()).models);
        const discovery = buildOpencodeZenLiveProviderConfig({
          apiKey: "runtime-key",
          discoveryApiKey: "discovery-key",
          fetchGuard,
        });

        if (advertising === "failed") {
          await expect(discovery).rejects.toThrow("model advertising unavailable");
        } else {
          await expect(discovery).resolves.toMatchObject({ models: [] });
        }
        expect(provider.resolveDynamicModel?.({ modelId: retiredId } as never)).toMatchObject({
          id: retiredId,
        });
      } finally {
        clearLiveCatalogCacheForTests();
        await prepareOpencodeZenModel({
          modelId: retiredId,
          fetchGuard: createCatalogFetchGuard({ metadata: [], advertised: [] }),
        });
        clearLiveCatalogCacheForTests();
      }
    },
  );

  it.each([
    [["claude-opus-5"], "opencode/claude-opus-5"],
    [["gpt-5.6-sol"], undefined],
  ])("selects only the advertised preferred onboarding model %#", async (modelIds, expected) => {
    const fetchGuard = vi.fn(async () =>
      guardedResponse(MODELS_URL, {
        data: modelIds.map((id) => ({ id, object: "model" })),
      }),
    );

    await expect(
      resolveOpencodeZenStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode/claude-opus-5",
        fetchGuard,
      }),
    ).resolves.toBe(expected);
  });

  it.each([
    ["off", undefined],
    ["max", "max"],
  ] as const)("keeps Kimi K3 reasoning %s exact", async (thinkingLevel, expectedEffort) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload: Record<string, unknown> = { model: "kimi-k3", reasoning_effort: "max" };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode",
      modelId: "kimi-k3",
      thinkingLevel,
    } as never);

    await streamFn?.(
      { provider: "opencode", id: "kimi-k3", api: "openai-completions" } as never,
      {} as never,
      {},
    );
    expect(capturedPayloads).toEqual([
      expectedEffort === undefined
        ? { model: "kimi-k3" }
        : { model: "kimi-k3", reasoning_effort: expectedEffort },
    ]);
  });

  it("canonicalizes stale OpenCode Zen base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode",
        model: {
          provider: "opencode",
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: MODELS_URL.replace("/models", ""),
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen");
    expect(
      provider.normalizeTransport?.({
        provider: "opencode",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen",
      } as never),
    ).toEqual({ api: "openai-completions", baseUrl: "https://opencode.ai/zen/v1" });
  });

  it("exposes provider-owned thinking levels for proxied models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveThinkingProfile = provider.resolveThinkingProfile;
    if (!resolveThinkingProfile) {
      throw new Error("expected OpenCode provider thinking profile");
    }

    const opusProfile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4-7",
    });
    expect(opusProfile?.levels.map((level) => level.id)).toContain("adaptive");
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "kimi-k3",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["max"] },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "max" }], defaultLevel: "off" });
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "big-pickle",
        api: "openai-completions",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off", label: "always on" }], defaultLevel: "off" });
  });
});
