// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../../api/types.ts";
import {
  buildModelProviderCards,
  buildSelectableDefaultModels,
  classifyModelProviderCard,
  modelCatalogRef,
  readModelProviderConfig,
  type ModelProviderCard,
} from "./data.ts";

function catalogEntry(overrides: Partial<ModelCatalogEntry> & { provider: string }) {
  return {
    id: `${overrides.provider}/model`,
    name: "Model",
    available: false,
    ...overrides,
  } satisfies ModelCatalogEntry;
}

function authStatus(
  providers: ModelAuthStatusResult["providers"],
  providerCapabilities?: ModelAuthStatusResult["providerCapabilities"],
): ModelAuthStatusResult {
  return { ts: 1, providers, ...(providerCapabilities ? { providerCapabilities } : {}) };
}

function firstCard(cards: ReturnType<typeof buildModelProviderCards>) {
  return expectDefined(cards[0], "first model provider card");
}

function providerCard(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "test",
    displayName: "Test",
    profiles: [],
    credentialProviderIds: [],
    logoutTargets: [],
    accessOptions: [],
    hasConfigApiKey: false,
    modelCount: 0,
    availableModelCount: 0,
    runtimeAvailableModelCount: 0,
    runtimeLabels: [],
    ...overrides,
  };
}

function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

const EMPTY_INPUT = {
  authStatus: null,
  models: null,
  providerUsage: null,
  costByProvider: null,
};
const redactedConfigValue = "[redacted]";

describe("buildModelProviderCards", () => {
  it("omits API-key-only auth rows without model-provider evidence", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "web-search",
          displayName: "Web Search",
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "WEB_SEARCH_API_KEY" },
        },
        {
          provider: "web-extract",
          displayName: "Web Extract",
          status: "static",
          profiles: [{ profileId: "extract", type: "api_key", status: "static" }],
        },
      ]),
    });
    expect(cards).toEqual([]);
  });

  it.each([true, false])(
    "keeps environment-only model auth independently of API-key setup support (%s)",
    (apiKeySupported) => {
      const cards = buildModelProviderCards({
        ...EMPTY_INPUT,
        authStatus: authStatus(
          [
            {
              provider: "model-service",
              displayName: "Model Service",
              status: "static",
              profiles: [],
              apiKey: { source: "env", envVar: "MODEL_SERVICE_API_KEY" },
            },
            {
              provider: "web-search",
              displayName: "Web Search",
              status: "static",
              profiles: [],
              apiKey: { source: "env", envVar: "WEB_SEARCH_API_KEY" },
            },
          ],
          [
            { provider: "model-service", apiKeySupported, quickApiKeySetup: false },
            { provider: "unconfigured-model", apiKeySupported: true, quickApiKeySetup: true },
          ],
        ),
      });
      expect(cards).toHaveLength(1);
      expect(firstCard(cards)).toMatchObject({
        id: "model-service",
        modelCount: 0,
        apiKeySupported,
        apiKey: { source: "env", envVar: "MODEL_SERVICE_API_KEY" },
        credentialProviderIds: ["model-service"],
      });
    },
  );

  it.each(["oauth", "token"] as const)(
    "keeps auth-only %s profiles, including non-expiring tokens",
    (type) => {
      const status = type === "token" ? "static" : "ok";
      const cards = buildModelProviderCards({
        ...EMPTY_INPUT,
        authStatus: authStatus([
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status,
            profiles: [{ profileId: "primary", type, status, logoutSupported: true }],
          },
          {
            provider: "claude-cli",
            displayName: "Claude",
            status: "static",
            profiles: [{ profileId: "secondary", type: "api_key", status: "static" }],
          },
        ]),
      });
      expect(cards).toHaveLength(1);
      expect(firstCard(cards)).toMatchObject({
        id: "anthropic",
        modelCount: 0,
        profiles: [
          { profileId: "primary", type, status, logoutSupported: true },
          { profileId: "secondary", type: "api_key", status: "static" },
        ],
        logoutTargets: [{ provider: "anthropic", profileIds: ["primary"] }],
      });
    },
  );

  it("uses catalog models to decorate configured providers without promoting catalog-only rows", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      configProviderIds: ["anthropic", "mistral"],
      models: [
        catalogEntry({
          provider: "anthropic",
          id: "anthropic/a",
          available: true,
          agentRuntime: { id: "claude-cli", source: "model" },
        }),
        catalogEntry({ provider: "anthropic", id: "anthropic/b" }),
        catalogEntry({ provider: "mistral", id: "mistral/large" }),
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["anthropic", "mistral"]);
    expect(cards[0]).toMatchObject({
      modelCount: 2,
      availableModelCount: 1,
      runtimeAvailableModelCount: 1,
      runtimeLabels: ["Claude CLI"],
    });
    expect(cards[1]).toMatchObject({ modelCount: 1, availableModelCount: 0 });

    expect(
      buildModelProviderCards({
        ...EMPTY_INPUT,
        models: [catalogEntry({ provider: "openrouter", available: true })],
      }),
    ).toEqual([]);
  });

  it("keeps provider-owned catalog failures on configured cards", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      configProviderIds: ["openai"],
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
    });

    expect(cards).toHaveLength(1);
    expect(firstCard(cards)).toMatchObject({
      id: "openai",
      catalogStatus: "auth-rejected",
      modelCount: 0,
      availableModelCount: 0,
    });
  });

  it("propagates explicit API-key capability onto provider cards", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      configProviderIds: ["github-copilot"],
      models: [catalogEntry({ provider: "github-copilot", available: true })],
      authStatus: authStatus([], [{ provider: "github-copilot", apiKeySupported: false }]),
    });
    expect(firstCard(cards).apiKeySupported).toBe(false);
  });

  it("keeps capability-only providers in Connect and decorates configured cards", () => {
    const capability = {
      provider: "xai",
      apiKeySupported: true,
      accessOptions: [{ id: "xai-oauth", label: "xAI OAuth", mode: "login" as const }],
    };
    expect(
      buildModelProviderCards({
        ...EMPTY_INPUT,
        authStatus: authStatus([], [capability]),
      }),
    ).toEqual([]);

    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus(
        [
          {
            provider: "xai",
            displayName: "xAI",
            status: "ok",
            profiles: [{ profileId: "xai:default", type: "oauth", status: "ok" }],
          },
        ],
        [capability],
      ),
    });

    expect(cards).toHaveLength(1);
    expect(firstCard(cards)).toMatchObject({
      id: "xai",
      apiKeySupported: true,
      accessOptions: capability.accessOptions,
    });
  });

  it("merges CLI alias auth rows into the canonical provider card", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [catalogEntry({ provider: "anthropic", available: true })],
      authStatus: authStatus(
        [
          {
            provider: "claude-cli",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "p1", type: "oauth", status: "ok" }],
            usage: {
              providerId: "anthropic",
              windows: [{ label: "5h", usedPercent: 40 }],
              plan: "Max",
            },
          },
        ],
        [
          {
            provider: "anthropic",
            apiKeySupported: true,
            accessOptions: [{ id: "apiKey", label: "Anthropic API key", mode: "login" }],
          },
        ],
      ),
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards)).toMatchObject({
      id: "anthropic",
      credentialProviderIds: ["claude-cli"],
      displayName: "Claude",
      auth: { kind: "ok", profileCount: 1 },
      accessOptions: [{ id: "apiKey", label: "Anthropic API key", mode: "login" }],
    });
    expect(firstCard(cards).usage).toMatchObject({
      provider: "anthropic",
      plan: "Max",
      windows: [{ label: "5h", usedPercent: 40 }],
    });
  });

  it("merges CLI alias auth rows even when usage enrichment is unavailable", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [catalogEntry({ provider: "anthropic", available: true })],
      authStatus: authStatus([
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "expired",
          profiles: [{ profileId: "p1", type: "oauth", status: "expired" }],
        },
      ]),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "anthropic",
      displayName: "Claude",
      auth: { kind: "expired" },
      availableModelCount: 1,
    });
  });

  it("keeps the most urgent auth state when alias rows share a card", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "ok",
          profiles: [{ profileId: "p1", type: "oauth", status: "ok", logoutSupported: true }],
          usage: { providerId: "anthropic", windows: [] },
        },
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "expired",
          expiry: { at: 1, remainingMs: -1, label: "-1m" },
          profiles: [{ profileId: "p2", type: "oauth", status: "expired", logoutSupported: true }],
          usage: { providerId: "anthropic", windows: [] },
        },
      ]),
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards).auth).toMatchObject({
      kind: "expired",
      profileCount: 2,
      expiryLabel: "-1m",
    });
    expect(firstCard(cards).credentialProviderIds).toEqual(["anthropic", "claude-cli"]);
    expect(firstCard(cards).logoutTargets).toEqual([
      { provider: "anthropic", profileIds: ["p1"] },
      { provider: "claude-cli", profileIds: ["p2"] },
    ]);
  });

  it("keeps a credential-less missing route visible beside CLI OAuth", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "missing",
          profiles: [],
        },
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "expiring",
          profiles: [{ profileId: "anthropic:claude-cli", type: "oauth", status: "expiring" }],
        },
      ]),
    });

    expect(firstCard(cards).auth).toMatchObject({ kind: "missing", profileCount: 1 });
  });

  it("preserves missing MiniMax OAuth beside a separate API key", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "minimax",
          displayName: "MiniMax",
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "MINIMAX_API_KEY" },
        },
        {
          provider: "minimax-portal",
          displayName: "MiniMax",
          status: "missing",
          profiles: [],
        },
      ]),
    });

    expect(firstCard(cards).auth).toMatchObject({ kind: "missing", profileCount: 0 });
  });

  it("prefers usage.status snapshots over the auth-status embed", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [{ profileId: "p1", type: "oauth", status: "ok" }],
          usage: { providerId: "openai", windows: [{ label: "5h", usedPercent: 10 }] },
        },
      ]),
      providerUsage: {
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 55 }],
            costHistory: {
              unit: "USD",
              periodDays: 30,
              daily: [
                {
                  date: "2026-07-09",
                  amount: 1.5,
                  inputTokens: 10,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 5,
                  totalTokens: 15,
                },
              ],
              models: [],
              categories: [],
            },
          },
        ],
      },
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards).usage?.windows).toEqual([{ label: "5h", usedPercent: 55 }]);
    expect(firstCard(cards).usage?.costHistory?.periodDays).toBe(30);
  });

  it("attaches local session spend via alias ids and includes cost-only providers", () => {
    const totals = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      totalCost: 0.42,
      inputCost: 0.3,
      outputCost: 0.12,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus([
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "ok",
          profiles: [],
          usage: { providerId: "anthropic", windows: [] },
        },
      ]),
      costByProvider: [
        { provider: "anthropic", count: 3, totals },
        { provider: "openrouter", count: 1, totals },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["anthropic", "openrouter"]);
    expect(firstCard(cards).localCost).toEqual({
      totalCost: 0.42,
      totalTokens: 150,
      sessionCount: 3,
      missingCostEntries: 0,
    });
  });

  it("sorts providers with active access first, then by display name", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      authStatus: authStatus(
        [
          {
            provider: "xai",
            displayName: "xAI",
            status: "ok",
            profiles: [{ profileId: "xai:falcon", type: "oauth", status: "ok" }],
          },
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "expiring",
            profiles: [{ profileId: "openai:falcon", type: "token", status: "expiring" }],
          },
          {
            provider: "deepseek",
            displayName: "DeepSeek",
            status: "static",
            profiles: [],
            apiKey: { source: "env", envVar: "DEEPSEEK_API_KEY" },
          },
          {
            provider: "mistral",
            displayName: "Mistral",
            status: "expired",
            profiles: [{ profileId: "mistral:old", type: "token", status: "expired" }],
          },
          { provider: "cohere", displayName: "Cohere", status: "missing", profiles: [] },
        ],
        [
          {
            provider: "deepseek",
            apiKeySupported: true,
            quickApiKeySetup: false,
          },
          {
            provider: "github-copilot",
            apiKeySupported: false,
            accessOptions: [{ id: "copilot", label: "GitHub Copilot", mode: "login" }],
          },
        ],
      ),
    });
    expect(cards.map((card) => card.id)).toEqual([
      "deepseek",
      "openai",
      "xai",
      "cohere",
      "mistral",
    ]);
  });

  it.each([
    [
      "healthy stored access",
      providerCard({
        auth: { kind: "ok", profileCount: 1 },
        profiles: [{ profileId: "test:oauth", type: "oauth", status: "ok" }],
      }),
      { status: "configured", sortTier: "active", verified: false, configured: true },
    ],
    [
      "catalog rejection over expiring access",
      providerCard({ auth: { kind: "expiring", profileCount: 1 }, catalogStatus: "auth-rejected" }),
      { status: "denied", sortTier: "inactive", verified: false, configured: false },
    ],
    [
      "renewing static access",
      providerCard({ auth: { kind: "expiring", profileCount: 1 } }),
      { status: "auth", sortTier: "active", verified: false, configured: false },
    ],
    [
      "expired access despite a stale runtime model",
      providerCard({ auth: { kind: "expired", profileCount: 1 }, runtimeAvailableModelCount: 1 }),
      { status: "auth", sortTier: "inactive", verified: false, configured: false },
    ],
    [
      "verified native runtime",
      providerCard({ runtimeAvailableModelCount: 1, availableModelCount: 1 }),
      { status: "ready", sortTier: "active", verified: true, configured: false },
    ],
    [
      "verified runtime without a visible model",
      providerCard({ runtimeAvailableModelCount: 1 }),
      { status: "available", sortTier: "active", verified: true, configured: false },
    ],
    [
      "temporary provider failure with valid access",
      providerCard({ auth: { kind: "api-key", profileCount: 0 }, catalogStatus: "unavailable" }),
      { status: "unavailable", sortTier: "active", verified: false, configured: false },
    ],
    [
      "unresolved API-key reference",
      providerCard({
        auth: {
          kind: "missing",
          profileCount: 1,
          unavailableMessage: "API key reference not found: env OPENAI_API_KEY",
        },
      }),
      {
        status: "unavailable",
        sortTier: "inactive",
        verified: false,
        configured: false,
        message: "API key reference not found: env OPENAI_API_KEY",
      },
    ],
    [
      "unconfigured provider",
      providerCard(),
      { status: "not-set-up", sortTier: "inactive", verified: false, configured: false },
    ],
  ] as const)("classifies %s once for status and ordering", (_name, card, expected) => {
    expect(classifyModelProviderCard(card)).toEqual(expected);
  });

  it("keeps API key provenance and config-only providers", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      configProviderIds: ["mistral", "OpenAI"],
      configApiKeyProviderIds: ["OpenAI"],
      configProviderAuthModes: { OpenAI: "api-key" },
      authStatus: authStatus([
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
        },
      ]),
    });
    expect(cards.map((card) => card.id)).toEqual(["openai", "mistral"]);
    expect(firstCard(cards)).toMatchObject({
      apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
      configKey: "OpenAI",
      configAuthMode: "api-key",
      credentialProviderIds: ["OpenAI"],
      hasConfigApiKey: true,
      profiles: [],
    });
  });
});

describe("model provider configuration data", () => {
  it("offers usable defaults while preserving saved unavailable refs", () => {
    const models = [
      catalogEntry({ provider: "openai", id: "gpt-ready", available: true }),
      catalogEntry({ provider: "openai", id: "gpt-disabled", available: false }),
    ];
    const selectable = buildSelectableDefaultModels(models, {
      primary: "openai/gpt-saved",
      fallbacks: ["openai/gpt-disabled"],
      utilityModel: null,
    });
    expect(selectable.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-ready",
      "openai/gpt-disabled",
      "openai/gpt-saved",
    ]);
  });

  it.each(["openai/gpt-saved", "saved-model"])(
    "keeps saved %s available when the catalog is unknown, but not when it is empty",
    (primary) => {
      const selection = { primary, fallbacks: [], utilityModel: null };

      expect(buildSelectableDefaultModels(null, selection)[0]).not.toHaveProperty("available");
      expect(buildSelectableDefaultModels([], selection)[0]).toMatchObject({ available: false });
    },
  );

  it("preserves alias-valued and bare model defaults as picker options", () => {
    const selectable = buildSelectableDefaultModels(
      [catalogEntry({ provider: "anthropic", id: "claude-opus", alias: "Opus", available: true })],
      { primary: "opus", fallbacks: ["unknown-model"], utilityModel: null },
    );
    expect(selectable.map(modelCatalogRef)).toEqual([
      "anthropic/claude-opus",
      "opus",
      "unknown-model",
    ]);
  });

  it("reads string and object model defaults", () => {
    expect(
      readModelProviderConfig({
        models: {
          providers: { openai: providerConfig(redactedConfigValue), anthropic: {} },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["anthropic/claude-sonnet-4-5", 42],
            },
            utilityModel: "openai/gpt-5-mini",
          },
        },
      }),
    ).toEqual({
      providerIds: ["openai", "anthropic"],
      apiKeyProviderIds: ["openai"],
      providerAuthModes: {},
      defaults: {
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude-sonnet-4-5"],
        utilityModel: "openai/gpt-5-mini",
      },
    });
    expect(
      readModelProviderConfig({ agents: { defaults: { model: "openai/gpt-5" } } }).defaults,
    ).toEqual({ primary: "openai/gpt-5", fallbacks: [], utilityModel: null });
    expect(
      readModelProviderConfig({ agents: { defaults: { utilityModel: "" } } }).defaults.utilityModel,
    ).toBe("");
  });

  it("retains explicit provider auth modes for API-key edit gating", () => {
    expect(
      readModelProviderConfig({
        models: { providers: { OpenAI: { auth: "oauth" } } },
      }).providerAuthModes,
    ).toEqual({ OpenAI: "oauth" });
  });
});
