import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCerebrasCatalogModels } from "./api.js";
import plugin from "./index.js";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<LiveModelCatalogFetchGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  ...ssrfRuntimeMocks,
}));

const CEREBRAS_PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models";
const NATIVE_TEXT_MODEL = {
  id: "fixture-text-model",
  object: "model",
  name: "Fixture Text Model",
  pricing: { prompt: "0.00000035", completion: "0.00000075" },
  capabilities: { reasoning: true, vision: false, tools: true },
  limits: { max_context_length: 131072, max_completion_tokens: 40960 },
};

type CatalogContext = Parameters<NonNullable<ProviderPlugin["catalog"]>["run"]>[0];

function createCatalogContext(overrides: Partial<CatalogContext> = {}): CatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: "fixture-cerebras-key",
      discoveryApiKey: "fixture-discovery-key",
    }),
    resolveProviderAuth: () => ({
      apiKey: "fixture-cerebras-key",
      discoveryApiKey: "fixture-discovery-key",
      mode: "api_key",
      source: "env",
    }),
    ...overrides,
  };
}

function mockCatalogResponse(body: unknown, init?: ResponseInit) {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }) => ({
    response: Response.json(body, init),
    finalUrl: url,
    release: async () => {},
  }));
}

async function runCerebrasCatalog(ctx = createCatalogContext()) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run(ctx);
  if (!result || !("provider" in result)) {
    throw new Error("expected authenticated Cerebras provider catalog");
  }
  return result.provider;
}

beforeEach(() => {
  clearLiveCatalogCacheForTests();
});

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
});

describe("Cerebras onboarding", () => {
  it.each(["default", "merge", "replace"] as const)(
    "keeps generated prices replace-only while selecting the default and alias in %s mode",
    (mode) => {
      const config = applyCerebrasConfig(mode === "default" ? {} : { models: { mode } });

      expect(config.models?.mode).toBe(mode === "replace" ? "replace" : "merge");
      expect(config.models?.providers?.cerebras?.models.map((model) => model.id)).toEqual(
        mode === "replace"
          ? manifest.modelCatalog.providers.cerebras.models.map((model) => model.id)
          : [],
      );
      if (mode === "replace") {
        expect(config.models?.providers?.cerebras?.models).toEqual(buildCerebrasCatalogModels());
      }
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        CEREBRAS_DEFAULT_MODEL_REF,
      );
      expect(config.agents?.defaults?.models).toEqual({
        [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
      });
    },
  );

  it.each([
    { label: "zero", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { label: "custom", cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 } },
  ])(
    "preserves authored $label prices, aliases, and selections without adding merge-mode pins",
    ({ cost }) => {
      const config = applyCerebrasConfig({});
      const [seed] = buildCerebrasCatalogModels();
      if (!seed) {
        throw new Error("expected a Cerebras seed model");
      }
      const model = { ...structuredClone(seed), id: "fixture-authored-model", cost };
      config.models!.providers!.cerebras!.models = [model];
      config.models!.providers!.cerebras!.apiKey = "fixture-key";
      config.agents!.defaults!.model = {
        primary: "cerebras/fixture-authored-model",
        fallbacks: ["fixture-provider/fallback"],
      };
      config.agents!.defaults!.models = {
        [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "My default alias" },
        "cerebras/fixture-authored-model": { alias: "My authored model" },
      };

      const reapplied = applyCerebrasConfig(config);

      expect(reapplied.models?.providers?.cerebras?.models).toEqual([model]);
      expect(reapplied.models?.providers?.cerebras?.apiKey).toBe("fixture-key");
      expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
    },
  );

  it("preserves an existing primary during non-interactive auth setup", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth?.[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Cerebras non-interactive auth method");
    }

    const result = await method.runNonInteractive({
      authChoice: "cerebras-api-key",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "anthropic/claude-sonnet-4-6": { alias: "Existing" } },
          },
        },
      },
      opts: {},
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      resolveApiKey: vi.fn(async () => ({ key: "fixture-value", source: "profile" })),
      toApiKeyCredential: vi.fn(() => null),
    } as never);

    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(result?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Existing" },
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
    });
  });
});

describe("Cerebras native catalog", () => {
  it("discovers native prices, limits, and capabilities without sending credentials", async () => {
    mockCatalogResponse({
      object: "list",
      data: [
        NATIVE_TEXT_MODEL,
        {
          ...NATIVE_TEXT_MODEL,
          id: "fixture-vision-model",
          name: "Fixture Vision Model",
          pricing: { prompt: "0.00000099", completion: "0.00000149" },
          capabilities: { reasoning: false, vision: true, tools: true },
          limits: { max_context_length: 262144, max_completion_tokens: 65536 },
        },
      ],
    });

    const catalog = await runCerebrasCatalog();

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
    const request = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls[0]?.[0];
    expect(request?.url).toBe(CEREBRAS_PUBLIC_MODELS_URL);
    expect(Object.fromEntries(new Headers(request?.init?.headers))).toEqual({
      accept: "application/json",
    });
    expect(catalog).toMatchObject({
      apiKey: "fixture-cerebras-key",
      api: "openai-completions",
      baseUrl: "https://api.cerebras.ai/v1",
    });
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fixture-text-model",
          name: "Fixture Text Model",
          reasoning: true,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 40960,
        }),
        expect.objectContaining({
          id: "fixture-vision-model",
          name: "Fixture Vision Model",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 262144,
          maxTokens: 65536,
        }),
      ]),
    );
    for (const [id, input, output] of [
      ["fixture-text-model", 0.35, 0.75],
      ["fixture-vision-model", 0.99, 1.49],
    ] as const) {
      const model = catalog.models.find((entry) => entry.id === id);
      expect(model?.cost.input).toBeCloseTo(input, 10);
      expect(model?.cost.output).toBeCloseTo(output, 10);
      expect(model?.cost).toMatchObject({ cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("preserves zero input prices without discarding a paid output rate", async () => {
    mockCatalogResponse({
      data: [{ ...NATIVE_TEXT_MODEL, pricing: { prompt: "0", completion: "0.00000075" } }],
    });

    const catalog = await runCerebrasCatalog();

    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: NATIVE_TEXT_MODEL.id,
        cost: { input: 0, output: 0.75, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
  });

  it.each([
    { label: "absent pricing", pricing: undefined },
    { label: "missing completion", pricing: { prompt: "0.00000035" } },
    { label: "negative prompt", pricing: { prompt: "-0.00000035", completion: "0.00000075" } },
    { label: "malformed completion", pricing: { prompt: "0.00000035", completion: "unknown" } },
  ])("keeps an available row with the unknown runtime price for $label", async ({ pricing }) => {
    mockCatalogResponse({ data: [{ ...NATIVE_TEXT_MODEL, pricing }] });

    const catalog = await runCerebrasCatalog();

    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: NATIVE_TEXT_MODEL.id,
        // Required runtime cost retains its unknown placeholder, not a free-billing claim.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
  });

  it.each(["https://proxy.example.test/cerebras/v1", "https://api.cerebras.ai/custom/v1"])(
    "does not query public metadata for custom inference base %s",
    async (baseUrl) => {
      const catalog = await runCerebrasCatalog(
        createCatalogContext({
          config: { models: { providers: { cerebras: { baseUrl, models: [] } } } },
        }),
      );

      expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
      expect(catalog.baseUrl).toBe(baseUrl);
      expect(catalog.apiKey).toBe("fixture-cerebras-key");
      expect(catalog.models.map((model) => model.id)).toEqual(
        manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
      );
    },
  );

  it("keeps static discovery offline and retains the shipped GLM reference", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.staticCatalog?.run(createCatalogContext());

    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    if (!result || !("provider" in result)) {
      throw new Error("expected static Cerebras provider catalog");
    }
    expect(result.provider.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
    expect(result.provider.models).toContainEqual(expect.objectContaining({ id: "zai-glm-4.7" }));
    const glm = manifest.modelCatalog.providers.cerebras.models.find(
      (model) => model.id === "zai-glm-4.7",
    );
    expect(glm).toBeDefined();
    expect(glm).not.toMatchObject({ status: "disabled" });
    expect(glm).not.toHaveProperty("replacedBy");
  });

  it("falls back offline after discovery failure and retries on the next request", async () => {
    mockCatalogResponse({ error: "unavailable" }, { status: 503 });
    const fallback = await runCerebrasCatalog();
    expect(fallback.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );

    mockCatalogResponse({ data: [NATIVE_TEXT_MODEL] });
    const recovered = await runCerebrasCatalog();

    expect(recovered.models).toEqual([
      expect.objectContaining({
        id: NATIVE_TEXT_MODEL.id,
        cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("keeps the runtime catalog inactive without a Cerebras credential", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const ctx = createCatalogContext({
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    await expect(provider.catalog?.run(ctx)).resolves.toBeNull();
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("does not resolve credentials or query metadata for an unrelated provider scope", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const resolveProviderApiKey = vi.fn<CatalogContext["resolveProviderApiKey"]>();
    const resolveProviderAuth = vi.fn<CatalogContext["resolveProviderAuth"]>();
    const ctx = createCatalogContext({
      providerIds: ["fixture-other-provider"],
      resolveProviderApiKey,
      resolveProviderAuth,
    });

    await expect(provider.catalog?.run(ctx)).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(resolveProviderAuth).not.toHaveBeenCalled();
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
