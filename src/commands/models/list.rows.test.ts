// Model list row tests cover rendered row construction for model listing output.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalogSnapshot: vi.fn(),
  loadScopedModelCatalogSnapshot: vi.fn(),
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  resolveBundledProviderPolicySurface: vi.fn(() => null),
  shouldSuppressBuiltInModelCore: vi.fn(() => false),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModelCore: mocks.shouldSuppressBuiltInModelCore,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: mocks.loadModelCatalogSnapshot,
}));

vi.mock("./list.scoped-catalog.js", () => ({
  loadScopedListModelCatalogSnapshot: mocks.loadScopedModelCatalogSnapshot,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

vi.mock("../../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: mocks.resolveBundledProviderPolicySurface,
}));

import {
  appendAuthenticatedCatalogRows,
  appendConfiguredRows,
  appendConfiguredProviderRows,
  appendDiscoveredRows,
  appendPreparedModelCatalogRows,
  loadListModelCatalogSnapshot,
  type RowBuilderContext,
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

function createRowContext(
  overrides: Pick<RowBuilderContext, "authIndex"> & Partial<RowBuilderContext>,
): RowBuilderContext {
  return {
    cfg: {},
    agentDir: "/tmp/openclaw-agent",
    canonicalizeProvider: normalizeProviderId,
    configuredByKey: new Map(),
    discoveredKeys: new Set(),
    filter: {},
    ...overrides,
  };
}

function requireOnlyRow(rows: ModelRow[]): ModelRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error("expected one model row");
  }
  return row;
}

async function appendCommittedProviderCatalogRows(params: {
  rows: ModelRow[];
  seenKeys: Set<string>;
  catalogModels: ModelCatalogEntry[];
  context: RowBuilderContext;
}): Promise<void> {
  const { catalogModels, ...projection } = params;
  await appendPreparedModelCatalogRows({
    ...projection,
    catalogSnapshot: {
      entries: catalogModels,
      routeVariants: catalogModels,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendPreparedModelCatalogRows", () => {
  it("projects the committed OpenAI route variants without rediscovering the catalog", async () => {
    const platform = {
      id: "gpt-5.5",
      name: "Platform GPT-5.5",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: 1_000_000,
    };
    const chatgpt = {
      ...platform,
      name: "ChatGPT GPT-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"] as ("text" | "image")[],
      contextWindow: 400_000,
    };
    const selectedRoute = {
      api: chatgpt.api,
      baseUrl: chatgpt.baseUrl,
      authRequirement: "subscription" as const,
      requestTransportOverrides: "none" as const,
    };
    const evaluateModelAuth = vi.fn(() => ({
      availability: true,
      routeResolution: {
        kind: "routes" as const,
        routes: [selectedRoute] as [typeof selectedRoute],
      },
      selectedRoute,
    }));
    const rows: ModelRow[] = [];

    await appendPreparedModelCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogSnapshot: {
        entries: [platform],
        routeVariants: [platform, chatgpt],
        staticEntries: [platform],
      },
      context: createRowContext({
        authIndex: { evaluateModelAuth },
        filter: { provider: "openai" },
      }),
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      key: "openai/gpt-5.5",
      name: "ChatGPT GPT-5.5",
      input: "text",
      contextWindow: 400_000,
      available: true,
    });
    expect(evaluateModelAuth).toHaveBeenCalledWith("openai", {
      modelId: "gpt-5.5",
      observedRoutes: [
        { api: platform.api, baseUrl: platform.baseUrl },
        { api: chatgpt.api, baseUrl: chatgpt.baseUrl },
      ],
    });
    expect(mocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("projects static-only provider hooks from the same committed generation", async () => {
    const entry = {
      id: "nemotron-static",
      name: "Nemotron Static",
      provider: "nvidia",
      api: "openai-completions" as const,
      baseUrl: "https://integrate.api.nvidia.com/v1",
      input: ["text"] as "text"[],
    };
    const evaluateModelAuth = vi.fn(() => authEvaluation(true));
    const rows: ModelRow[] = [];

    await appendPreparedModelCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogSnapshot: {
        entries: [],
        routeVariants: [],
        staticEntries: [entry, entry],
      },
      context: createRowContext({
        authIndex: { evaluateModelAuth },
        filter: { provider: "nvidia" },
      }),
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      key: "nvidia/nemotron-static",
      name: "Nemotron Static",
      available: true,
    });
    expect(evaluateModelAuth).toHaveBeenCalledWith("nvidia", {
      modelId: "nemotron-static",
      observedRoutes: [{ api: entry.api, baseUrl: entry.baseUrl }],
    });
    expect(mocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("filters and deduplicates local rows from the committed generation", async () => {
    const local = {
      id: "qwen2.5:7b",
      name: "Qwen 2.5 7B",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      input: ["text"] as "text"[],
    };
    const rows: ModelRow[] = [];
    const seenKeys = new Set<string>();
    const params = {
      rows,
      seenKeys,
      catalogSnapshot: {
        entries: [local, { ...local, id: "remote", baseUrl: "https://models.example/v1" }],
        routeVariants: [local],
      },
      context: createRowContext({
        authIndex: { evaluateModelAuth: () => authEvaluation(true) },
        filter: { provider: "ollama", local: true },
      }),
    };

    await appendPreparedModelCatalogRows(params);
    await appendPreparedModelCatalogRows(params);

    expect(requireOnlyRow(rows)).toMatchObject({
      key: "ollama/qwen2.5:7b",
      local: true,
      available: true,
    });
    expect(seenKeys).toEqual(new Set(["ollama/qwen2.5:7b"]));
  });

  it("acquires exactly one read-only prepared generation when none was supplied", async () => {
    const entry = {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      provider: "anthropic",
      input: ["text"] as "text"[],
    };
    mocks.loadScopedModelCatalogSnapshot.mockReturnValueOnce({
      entries: [entry],
      routeVariants: [entry],
    });
    const rows: ModelRow[] = [];

    await appendPreparedModelCatalogRows({
      rows,
      seenKeys: new Set(),
      context: createRowContext({
        agentId: "worker",
        agentDir: "/tmp/openclaw-worker",
        inheritedAuthDir: "/tmp/openclaw-default",
        workspaceDir: "/tmp/openclaw-workspace",
        providerDiscoveryProviderIds: ["anthropic"],
        providerRuntimeDiscoveryProviderIds: ["anthropic"],
        providerManifestFallbackProviderIds: ["anthropic"],
        authIndex: {
          evaluateModelAuth: () => authEvaluation(true),
        },
        filter: { provider: "anthropic" },
      }),
    });

    expect(requireOnlyRow(rows).key).toBe("anthropic/claude-opus-4-7");
    expect(mocks.loadScopedModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      agentId: "worker",
      agentDir: "/tmp/openclaw-worker",
      inheritedAuthDir: "/tmp/openclaw-default",
      workspaceDir: "/tmp/openclaw-workspace",
      providerIds: ["anthropic"],
      runtimeProviderIds: ["anthropic"],
      manifestFallbackProviderIds: ["anthropic"],
      configuredKeys: [],
    });
    expect(mocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });
});

describe("loadListModelCatalogSnapshot", () => {
  it("opts the unscoped model list into stale catalog refresh", async () => {
    mocks.loadModelCatalogSnapshot.mockResolvedValue({ entries: [], routeVariants: [] });

    await loadListModelCatalogSnapshot(createRowContext({ authIndex }));

    expect(mocks.loadModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, refreshFullCatalog: "stale" }),
    );
  });
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
          contextWindow: 8192,
        },
      ] as never,
      context: createRowContext({
        authIndex: { evaluateModelAuth: () => authEvaluation(undefined) },
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
      }),
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
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => ({
            availability: true,
            routeResolution: { kind: "routes", routes: [selectedRoute] },
            selectedRoute,
          }),
        },
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
      }),
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
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => ({
            availability: false,
            routeResolution: { kind: "indeterminate", defaultRuntimeId: "codex" },
          }),
        },
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
      }),
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
      context: createRowContext({
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
        authIndex: {
          evaluateModelAuth: () => ({ availability: undefined, routeResolution: null }),
        },
        availableKeys: new Set(["openai/gpt-5.5"]),
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
      }),
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });

  it("evaluates configured-row auth with observed routes from the shared snapshot", async () => {
    const rows: ModelRow[] = [];
    const evaluateModelAuth = vi.fn(() => ({
      availability: true,
      routeResolution: null,
    }));
    const catalogEntry = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      input: ["text" as const],
    };

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
      catalogSnapshot: { entries: [catalogEntry], routeVariants: [catalogEntry] },
      context: createRowContext({
        authIndex: { evaluateModelAuth },
      }),
    });

    // The same physical routes the catalog rows use must inform configured-row
    // auth, so both views agree on availability for route-managed models.
    expect(evaluateModelAuth).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        observedRoutes: [{ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
      }),
    );
    expect(requireOnlyRow(rows)).toMatchObject({ key: "openai/gpt-5.5", contextWindow: 400_000 });
  });
});

describe("prepared provider catalog projection", () => {
  it("omits manifest-suppressed catalog rows", async () => {
    mocks.shouldSuppressBuiltInModelCore.mockReturnValueOnce(true);
    const rows: ModelRow[] = [];

    await appendCommittedProviderCatalogRows({
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
          contextWindow: 8192,
        },
      ],
      context: createRowContext({
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
        authIndex: {
          evaluateModelAuth: () => authEvaluation(false),
        },
        filter: { provider: "openai", local: false },
      }),
    });

    expect(mocks.shouldSuppressBuiltInModelCore).toHaveBeenCalledWith({
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

    await appendCommittedProviderCatalogRows({
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
          contextWindow: 8192,
        },
      ],
      context: createRowContext({
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
          models: { providers: {} },
        },
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
      }),
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

    await appendCommittedProviderCatalogRows({
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
          contextWindow: 8192,
        },
      ],
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => authEvaluation(undefined),
        },
        discoveredKeys: new Set(["openai/gpt-5.5"]),
        availableKeys: new Set(["openai/gpt-5.5"]),
        filter: { provider: "openai", local: false },
      }),
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });

  it("preserves registry-negative availability for non-route provider auth", async () => {
    const rows: ModelRow[] = [];

    await appendCommittedProviderCatalogRows({
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
          contextWindow: 8192,
        },
      ],
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => authEvaluation(true),
        },
        discoveredKeys: new Set(["anthropic/claude-sonnet-4-6"]),
        availableKeys: new Set(),
        filter: { provider: "anthropic", local: false },
      }),
    });

    expect(requireOnlyRow(rows).available).toBe(false);
  });

  it("keeps unresolved native route auth unknown without positive registry evidence", async () => {
    const rows: ModelRow[] = [];

    await appendCommittedProviderCatalogRows({
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
          contextWindow: 8192,
        },
      ],
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => authEvaluation(undefined),
        },
        filter: { provider: "openai", local: false },
      }),
    });

    expect(requireOnlyRow(rows).available).toBeNull();
  });
});

describe("appendConfiguredProviderRows", () => {
  it("skips provider runtime normalization when lightweight policy proves the row canonical", async () => {
    mocks.resolveBundledProviderPolicySurface.mockReturnValueOnce({
      projectConfiguredModelRow: () => null,
    } as never);
    const rows: ModelRow[] = [];

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: createRowContext({
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 96_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        },
        authIndex,
        filter: { provider: "openai", local: false },
      }),
    });

    expect(mocks.normalizeProviderResolvedModelWithPlugin).not.toHaveBeenCalled();
    expect(requireOnlyRow(rows).input).toBe("text");
  });

  it("keeps authored input while normalizing configured provider models", async () => {
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
      context: createRowContext({
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
        authIndex,
        filter: { provider: "anthropic", local: false },
      }),
    });

    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
    // models.providers is authoritative for configured capabilities. Runtime
    // normalization may fill provider details but must not add image input the
    // operator did not configure.
    expect(requireOnlyRow(rows).input).toBe("text");
  });

  it("threads configured model route facts into auth availability", async () => {
    const rows: ModelRow[] = [];
    const evaluateModelAuth = vi.fn(() => authEvaluation(false));

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: createRowContext({
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
        authIndex: {
          evaluateModelAuth,
        },
        availableKeys: new Set(["openai/gpt-5.6"]),
        discoveredKeys: new Set(["openai/gpt-5.6"]),
        filter: { provider: "openai", local: false },
      }),
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
      context: createRowContext({
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
        authIndex: {
          evaluateModelAuth,
        },
        filter: { provider: "openai", local: false },
      }),
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
  it("does not append authenticated catalog rows in replace mode", async () => {
    const rows: ModelRow[] = [];

    await appendAuthenticatedCatalogRows({
      rows,
      seenKeys: new Set(),
      context: createRowContext({
        cfg: { models: { mode: "replace" } },
        authIndex: {
          evaluateModelAuth: () => ({ availability: true, routeResolution: null }),
        },
      }),
    });

    expect(rows).toEqual([]);
    expect(mocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadScopedModelCatalogSnapshot).not.toHaveBeenCalled();
  });

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
    mocks.loadScopedModelCatalogSnapshot.mockReturnValueOnce({
      entries,
      routeVariants: entries,
    });
    const rows: ModelRow[] = [];

    await appendAuthenticatedCatalogRows({
      rows,
      seenKeys: new Set(),
      context: createRowContext({
        workspaceDir: "/tmp/openclaw-workspace",
        providerDiscoveryProviderIds: ["local-openai"],
        providerRuntimeDiscoveryProviderIds: ["local-openai"],
        authIndex: {
          evaluateModelAuth: () => ({
            availability: undefined,
            evidence: "synthetic",
            routeResolution: null,
          }),
        },
        filter: { provider: "local-openai", local: false },
      }),
    });

    expect(requireOnlyRow(rows)).toMatchObject({
      key: "local-openai/local-model",
      local: true,
      available: true,
    });
    expect(mocks.loadScopedModelCatalogSnapshot).toHaveBeenCalledWith({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      providerIds: ["local-openai"],
      runtimeProviderIds: ["local-openai"],
      configuredKeys: [],
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
      context: createRowContext({
        authIndex: {
          evaluateModelAuth: () => ({ availability: undefined, routeResolution: null }),
        },
        filter: { provider: "remote-provider", local: false },
      }),
    });

    expect(rows).toEqual([]);
  });
});
