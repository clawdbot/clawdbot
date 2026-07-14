import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../../api/types.ts";
import {
  buildModelProviderCards,
  buildSelectableDefaultModels,
  buildUnconfiguredProviderOptions,
  modelCatalogRef,
  readModelProviderConfig,
} from "./data.ts";

function catalogEntry(overrides: Partial<ModelCatalogEntry> & { provider: string }) {
  return {
    id: `${overrides.provider}/model`,
    name: "Model",
    available: false,
    ...overrides,
  } satisfies ModelCatalogEntry;
}

function authStatus(providers: ModelAuthStatusResult["providers"]): ModelAuthStatusResult {
  return { ts: 1, providers };
}

function firstCard(cards: ReturnType<typeof buildModelProviderCards>) {
  return expectDefined(cards[0], "first model provider card");
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
  it("keeps catalog providers, including ones whose models are all unavailable", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [
        catalogEntry({ provider: "anthropic", id: "anthropic/a", available: true }),
        catalogEntry({ provider: "anthropic", id: "anthropic/b" }),
        catalogEntry({ provider: "mistral", id: "mistral/large" }),
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["anthropic", "mistral"]);
    expect(cards[0]).toMatchObject({ modelCount: 2, availableModelCount: 1 });
    // A configured API-key provider with a broken credential still shows up
    // so the page can report its unavailable state.
    expect(cards[1]).toMatchObject({ modelCount: 1, availableModelCount: 0 });
  });

  it("propagates explicit API-key capability onto provider cards", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [catalogEntry({ provider: "github-copilot", available: true })],
      catalogModels: [catalogEntry({ provider: "github-copilot", apiKeySupported: false })],
    });
    expect(firstCard(cards).apiKeySupported).toBe(false);
  });

  it("merges CLI alias auth rows into the canonical provider card", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [catalogEntry({ provider: "anthropic", available: true })],
      authStatus: authStatus([
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
      ]),
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards)).toMatchObject({
      id: "anthropic",
      credentialProviderIds: ["claude-cli"],
      displayName: "Claude",
      auth: { kind: "ok", profileCount: 1 },
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
    });
  });

  it("sorts cards by display name", () => {
    const cards = buildModelProviderCards({
      ...EMPTY_INPUT,
      models: [
        catalogEntry({ provider: "openai", id: "openai/gpt", available: true }),
        catalogEntry({ provider: "anthropic", id: "anthropic/claude", available: true }),
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["anthropic", "openai"]);
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
    expect(cards.map((card) => card.id)).toEqual(["mistral", "openai"]);
    expect(cards[1]).toMatchObject({
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

  it("lists known providers that are not configured", () => {
    const options = buildUnconfiguredProviderOptions(
      [
        catalogEntry({ provider: "openai", apiKeySupported: true }),
        catalogEntry({ provider: "anthropic", apiKeySupported: true }),
        catalogEntry({ provider: "anthropic", id: "anthropic/other", apiKeySupported: true }),
        catalogEntry({ provider: "github-copilot", apiKeySupported: false }),
      ],
      ["openai"],
    );
    expect(options).toEqual([{ id: "anthropic", displayName: "Anthropic" }]);
  });
});
