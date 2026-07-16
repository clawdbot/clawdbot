// Model list row tests cover rendered row construction for model listing output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalogSnapshot: vi.fn(),
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  shouldSuppressBuiltInModel: vi.fn(() => {
    throw new Error("runtime model suppression should be skipped");
  }),
  shouldSuppressBuiltInModelFromManifest: vi.fn(() => false),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: mocks.shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest: mocks.shouldSuppressBuiltInModelFromManifest,
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalogSnapshot: mocks.loadModelCatalogSnapshot,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

import {
  appendAuthenticatedCatalogRows,
  appendConfiguredRows,
  appendConfiguredProviderRows,
  appendDiscoveredRows,
  appendProviderCatalogRows,
} from "./list.rows.js";

const authIndex = {
  evaluateModelAuth: (provider: string) => ({
    availability: provider === "codex",
    routeResolution: null,
  }),
};

function authEvaluation(availability: boolean | undefined) {
  return { availability, routeResolution: null };
}

function requireOnlyRow(rows: ModelRow[]): ModelRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error("expected one model row");
  }
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendDiscoveredRows", () => {
  it("does not borrow provider registry auth when an OpenAI route is unknown", async () => {
    const rows: ModelRow[] = [];

    await appendDiscoveredRows({
      rows,
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ] as never,
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: { evaluateModelAuth: () => authEvaluation(undefined) },
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });

  it("projects the selected ChatGPT row regardless of physical row order", async () => {
    const selectedRoute = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription" as const,
      requestTransportOverrides: "none" as const,
    };
    const rows: ModelRow[] = [];

    await appendDiscoveredRows({
      rows,
      models: [
        {
          id: "gpt-5.5",
          name: "Platform GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
        {
          id: "gpt-5.5",
          name: "ChatGPT GPT-5.5",
          provider: "openai",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 400_000,
          maxTokens: 128_000,
        },
      ] as never,
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          }),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      name: "ChatGPT GPT-5.5",
      input: "text",
      contextWindow: 400_000,
      available: true,
    });
  });

  it("omits physical capabilities while managed route selection is unresolved", async () => {
    const rows: ModelRow[] = [];

    await appendDiscoveredRows({
      rows,
      models: [
        {
          id: "gpt-5.5",
          name: "Platform GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ] as never,
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({
            availability: false,
            routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
          }),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      name: "Platform GPT-5.5",
      input: "-",
      contextWindow: null,
      available: false,
    });
  });
});

describe("appendConfiguredRows", () => {
  it("does not borrow discovered registry auth when an OpenAI route is unknown", async () => {
    const rows: ModelRow[] = [];

    await appendConfiguredRows({
      rows,
      entries: [
        {
          key: "openai/gpt-5.5",
          ref: { provider: "openai", model: "gpt-5.5" },
          tags: new Set(["default"]),
          aliases: [],
        },
      ],
      context: {
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 400_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({ availability: undefined, routeResolution: null }),
        },
        availableKeys: new Set(["openai/gpt-5.5"]),
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });
});

describe("appendProviderCatalogRows", () => {
  it("applies manifest suppression when runtime model-suppression hooks are skipped", async () => {
    mocks.shouldSuppressBuiltInModelFromManifest.mockReturnValueOnce(true);
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => authEvaluation(false),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(mocks.shouldSuppressBuiltInModelFromManifest).toHaveBeenCalledWith({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      baseUrl: "https://api.openai.com/v1",
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        models: { providers: {} },
      },
    });
    expect(rows).toStrictEqual([]);
  });

  it("uses Codex auth availability for configured canonical OpenAI rows", async () => {
    const rows: ModelRow[] = [];
    const evaluateModelAuth = vi.fn((_provider: string, ref: { modelId?: string }) =>
      authEvaluation(ref.modelId === "gpt-5.5"),
    );

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth,
        },
        configuredByKey: new Map([
          [
            "openai/gpt-5.5",
            {
              key: "openai/gpt-5.5",
              ref: { provider: "openai", model: "gpt-5.5" },
              tags: new Set(["configured"]),
              aliases: [],
            },
          ],
        ]),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    const row = requireOnlyRow(rows);
    expect(row.key).toBe("openai/gpt-5.5");
    expect(row.available).toBe(true);
    expect(row.tags).toEqual(["configured"]);
    expect(evaluateModelAuth).toHaveBeenCalledOnce();
    expect(evaluateModelAuth).toHaveBeenCalledWith("openai", {
      modelId: "gpt-5.5",
      observedRoutes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
  });

  it("preserves unknown route auth instead of borrowing provider registry availability", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => authEvaluation(undefined),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });

  it("preserves registry-negative availability for non-route provider auth", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => authEvaluation(true),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(["anthropic/claude-sonnet-4-6"]),
        availableKeys: new Set(),
        filter: { provider: "anthropic", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBe(false);
  });

  it("keeps unresolved native route auth unknown without positive registry evidence", async () => {
    const rows: ModelRow[] = [];

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogModels: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text", "image"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => authEvaluation(undefined),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });
});

describe("appendConfiguredProviderRows", () => {
  it("keeps provider normalization for configured provider models", async () => {
    mocks.normalizeProviderResolvedModelWithPlugin.mockReturnValueOnce({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 200_000,
    } as never);
    const rows: ModelRow[] = [];

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          models: {
            providers: {
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                models: [
                  {
                    id: "claude-sonnet-4-6",
                    name: "Claude Sonnet 4.6",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "anthropic", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
    expect(requireOnlyRow(rows).input).toBe("text+image");
  });

  it("threads configured model route facts into auth availability", async () => {
    const rows: ModelRow[] = [];
    const evaluateModelAuth = vi.fn(() => authEvaluation(false));

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.6",
                    name: "GPT-5.6",
                    reasoning: true,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1_050_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth,
        },
        availableKeys: new Set(["openai/gpt-5.6"]),
        configuredByKey: new Map(),
        discoveredKeys: new Set(["openai/gpt-5.6"]),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBe(false);
    expect(evaluateModelAuth).toHaveBeenCalledOnce();
    expect(evaluateModelAuth).toHaveBeenCalledWith("openai", {
      modelId: "gpt-5.6",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("preserves configured route facts when provider normalization omits them", async () => {
    mocks.normalizeProviderResolvedModelWithPlugin.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      input: ["text", "image"],
      contextWindow: 400_000,
    } as never);
    const rows: ModelRow[] = [];
    const evaluateModelAuth = vi.fn(() => authEvaluation(true));

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    reasoning: true,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 400_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth,
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows).available).toBe(true);
    expect(evaluateModelAuth).toHaveBeenCalledOnce();
    expect(evaluateModelAuth).toHaveBeenCalledWith("openai", {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });
});

describe("appendAuthenticatedCatalogRows", () => {
  it("keeps runnable synthetic local catalog rows", async () => {
    const entries = [
      {
        id: "local-model",
        name: "Local Model",
        provider: "local-openai",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ];
    mocks.loadModelCatalogSnapshot.mockResolvedValueOnce({ entries, routeVariants: entries });
    const rows: ModelRow[] = [];

    await appendAuthenticatedCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({
            availability: undefined,
            evidence: "synthetic",
            routeResolution: null,
          }),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "local-openai", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      key: "local-openai/local-model",
      local: true,
      available: true,
    });
  });

  it("still drops catalog rows with unresolved non-synthetic auth", async () => {
    const entries = [
      {
        id: "remote-model",
        name: "Remote Model",
        provider: "remote-provider",
        api: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ];
    mocks.loadModelCatalogSnapshot.mockResolvedValueOnce({ entries, routeVariants: entries });
    const rows: ModelRow[] = [];

    await appendAuthenticatedCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        authIndex: {
          evaluateModelAuth: () => ({ availability: undefined, routeResolution: null }),
        },
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "remote-provider", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(rows).toEqual([]);
  });
});
