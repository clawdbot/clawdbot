import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../../api/types.ts";
import { buildModelProviderCards } from "./data.ts";

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

const EMPTY_INPUT = {
  authStatus: null,
  models: null,
  providerUsage: null,
  costByProvider: null,
};

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
          profiles: [{ profileId: "p1", type: "oauth", status: "ok" }],
          usage: { providerId: "anthropic", windows: [] },
        },
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "expired",
          expiry: { at: 1, remainingMs: -1, label: "-1m" },
          profiles: [{ profileId: "p2", type: "oauth", status: "expired" }],
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
});
