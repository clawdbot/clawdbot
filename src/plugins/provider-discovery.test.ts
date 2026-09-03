/** Tests provider discovery normalization, grouping, and manifest contribution handling. */
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import type { ProviderCatalogOutcome } from "./provider-catalog.types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderCatalogOrder;
  aliases?: string[];
  hookAliases?: string[];
}): ProviderPlugin {
  const hook = {
    ...(params.order ? { order: params.order } : {}),
    run: async () => null,
  };
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [],
    ...(params.aliases ? { aliases: params.aliases } : {}),
    ...(params.hookAliases ? { hookAliases: params.hookAliases } : {}),
    catalog: hook,
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function makeModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function expectGroupedProviderIds(
  providers: readonly ProviderPlugin[],
  expected: Record<ProviderCatalogOrder | "late", readonly string[]>,
) {
  const grouped = groupPluginDiscoveryProvidersByOrder([...providers]);
  const actual = {
    simple: grouped.simple.map((provider) => provider.id),
    profile: grouped.profile.map((provider) => provider.id),
    paired: grouped.paired.map((provider) => provider.id),
    late: grouped.late.map((provider) => provider.id),
  };
  expect(actual).toEqual(expected);
}

function expectNormalizedDiscoveryResult(params: {
  provider: ProviderPlugin;
  result: Parameters<typeof normalizePluginDiscoveryResult>[0]["result"];
  expected: Record<string, unknown>;
}) {
  const normalized = normalizePluginDiscoveryResult({
    provider: params.provider,
    result: params.result,
  });
  expect(Object.getPrototypeOf(normalized)).toBe(null);
  expect(Object.fromEntries(Object.entries(normalized))).toEqual(params.expected);
}

type NormalizePluginDiscoveryResultCase = {
  name: string;
  provider: ProviderPlugin;
  result: Parameters<typeof normalizePluginDiscoveryResult>[0]["result"];
  expected: Record<string, unknown>;
};

describe("groupPluginDiscoveryProvidersByOrder", () => {
  it.each([
    {
      name: "groups providers by declared order and sorts labels within each group",
      providers: [
        makeProvider({ id: "late-b", label: "Zulu" }),
        makeProvider({ id: "late-a", label: "Alpha" }),
        makeProvider({ id: "paired", label: "Paired", order: "paired" }),
        makeProvider({ id: "profile", label: "Profile", order: "profile" }),
        makeProvider({ id: "simple", label: "Simple", order: "simple" }),
      ],
      expected: {
        simple: ["simple"],
        profile: ["profile"],
        paired: ["paired"],
        late: ["late-a", "late-b"],
      },
    },
  ] as const)("$name", ({ providers, expected }) => {
    expectGroupedProviderIds(providers, expected);
  });
});

describe("runProviderCatalog", () => {
  it("passes the selected provider identities into the catalog hook", async () => {
    let providerIds: readonly string[] | undefined;
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      auth: [],
      catalog: {
        run: async (ctx) => {
          providerIds = ctx.providerIds;
          return null;
        },
      },
    };

    await runProviderCatalog({
      provider,
      providerIds: ["azure-openai"],
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(providerIds).toEqual(["azure-openai"]);
  });

  it("carries explicit provider-owned catalog outcomes across an async hook", async () => {
    const outcomes: Array<{
      provider: string;
      profileId?: string;
      rejectionScope?: "catalog";
      status: "ready" | "auth-rejected" | "unavailable";
    }> = [];
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      auth: [],
      catalog: {
        run: async (ctx) => {
          await Promise.resolve();
          ctx.resolveProviderAuth("openai");
          return {
            providers: {},
            outcomes: [
              {
                provider: "openai",
                profileId: "openai:chatgpt",
                rejectionScope: "catalog",
                status: "auth-rejected",
              },
            ],
          };
        },
      },
    };

    await runProviderCatalog({
      provider,
      config: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: "selected-key",
        mode: "api_key",
        profileId: "openai:chatgpt",
        source: "profile",
      }),
      reportCatalogOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:chatgpt",
        rejectionScope: "catalog",
        status: "auth-rejected",
      },
    ]);
  });

  it("rejects catalog outcomes attributed to a different selected profile", async () => {
    const outcomes: ProviderCatalogOutcome[] = [];
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      auth: [],
      catalog: {
        run: async (ctx) => {
          ctx.resolveProviderAuth("proof-alias");
          return {
            providers: {},
            outcomes: [
              {
                provider: "openai",
                profileId: "openai:profile-a",
                status: "auth-rejected",
              },
            ],
          };
        },
      },
    };

    await expect(
      runProviderCatalog({
        provider,
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({
          apiKey: "selected-key",
          mode: "api_key",
          profileId: "openai:profile-b",
          source: "profile",
        }),
        resolveProviderAuthProviderId: (providerId) =>
          providerId === "proof-alias" ? "openai" : (providerId ?? "openai"),
        reportCatalogOutcome: (outcome) => outcomes.push(outcome),
      }),
    ).rejects.toThrow("did not match the selected authentication profile");
    expect(outcomes).toEqual([]);
  });

  it.each([
    { providerIds: ["OPENAI"], expected: ["openai"] },
    { providerIds: ["azure-openai"], expected: ["azure-openai"] },
    { providerIds: [], expected: [] },
  ])(
    "emits outcomes only for selected provider identities: $providerIds",
    async ({ providerIds, expected }) => {
      const outcomes: string[] = [];
      const provider: ProviderPlugin = {
        id: "openai",
        label: "OpenAI",
        auth: [],
        catalog: {
          run: async (ctx) => {
            ctx.resolveProviderAuth("openai");
            ctx.resolveProviderAuth("azure-openai");
            return {
              providers: {},
              outcomes: [
                { provider: "openai", profileId: "openai:private", status: "auth-rejected" },
                { provider: "azure-openai", profileId: "azure-openai:selected", status: "ready" },
                { provider: "unrelated", status: "unavailable" },
              ],
            };
          },
        },
      };

      await runProviderCatalog({
        provider,
        providerIds,
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: (providerId) => ({
          apiKey: "selected-key",
          mode: "api_key",
          profileId: providerId === "azure-openai" ? "azure-openai:selected" : "openai:private",
          source: "profile",
        }),
        reportCatalogOutcome: (outcome) => outcomes.push(outcome.provider),
      });

      expect(outcomes).toEqual(expected);
    },
  );
});

describe("normalizePluginDiscoveryResult", () => {
  const cases: NormalizePluginDiscoveryResultCase[] = [
    {
      name: "maps a single provider result to the plugin id",
      provider: makeProvider({ id: "Ollama" }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
        }),
      },
      expected: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          models: [],
        },
      },
    },
    {
      name: "maps a single provider result to aliases and hook aliases",
      provider: makeProvider({
        id: "Anthropic",
        aliases: ["anthropic-api"],
        hookAliases: ["claude-cli"],
      }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
        }),
      },
      expected: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [],
        },
        "anthropic-api": {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [],
        },
        "claude-cli": {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [],
        },
      },
    },
    {
      name: "normalizes keys for multi-provider discovery results",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          " VLLM ": makeModelProviderConfig(),
          "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
        },
      },
      expected: {
        vllm: {
          baseUrl: "http://127.0.0.1:8000/v1",
          models: [],
        },
      },
    },
    {
      name: "drops dangerous normalized provider keys",
      provider: makeProvider({ id: "__proto__", aliases: ["constructor"], hookAliases: ["safe"] }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "http://safe.example/v1",
        }),
      },
      expected: {
        safe: {
          baseUrl: "http://safe.example/v1",
          models: [],
        },
      },
    },
    {
      name: "drops dangerous multi-provider discovery keys",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          ["__proto__"]: makeModelProviderConfig({ baseUrl: "http://polluted.example/v1" }),
          constructor: makeModelProviderConfig({ baseUrl: "http://constructor.example/v1" }),
          prototype: makeModelProviderConfig({ baseUrl: "http://prototype.example/v1" }),
          safe: makeModelProviderConfig({ baseUrl: "http://safe.example/v1" }),
        },
      },
      expected: {
        safe: {
          baseUrl: "http://safe.example/v1",
          models: [],
        },
      },
    },
    {
      name: "skips unreadable multi-provider entries while preserving healthy siblings",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: Object.defineProperty(
          {
            healthy: makeModelProviderConfig({
              baseUrl: "http://healthy.example/v1",
            }),
          },
          "broken",
          {
            enumerable: true,
            get() {
              throw new Error("provider row read failed");
            },
          },
        ) as Record<string, ModelProviderConfig>,
      },
      expected: {
        healthy: {
          baseUrl: "http://healthy.example/v1",
          models: [],
        },
      },
    },
    {
      name: "skips providers with unreadable required fields",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          broken: Object.defineProperty(
            makeModelProviderConfig({
              baseUrl: "http://broken.example/v1",
              models: [makeModel("broken-model")],
            }),
            "baseUrl",
            {
              enumerable: true,
              get() {
                throw new Error("provider baseUrl read failed");
              },
            },
          ),
          healthy: makeModelProviderConfig({
            baseUrl: "http://healthy.example/v1",
            models: [makeModel("healthy-model")],
          }),
        },
      },
      expected: {
        healthy: {
          baseUrl: "http://healthy.example/v1",
          models: [makeModel("healthy-model")],
        },
      },
    },
    {
      name: "skips unreadable model rows while preserving healthy siblings",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          healthy: makeModelProviderConfig({
            baseUrl: "http://healthy.example/v1",
            models: Object.defineProperty([makeModel("healthy-model")], "1", {
              enumerable: true,
              get() {
                throw new Error("model row read failed");
              },
            }),
          }),
        },
      },
      expected: {
        healthy: {
          baseUrl: "http://healthy.example/v1",
          models: [makeModel("healthy-model")],
        },
      },
    },
    {
      name: "skips model rows with unreadable required fields",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          healthy: makeModelProviderConfig({
            baseUrl: "http://healthy.example/v1",
            models: [
              Object.defineProperty(makeModel("broken-model"), "id", {
                enumerable: true,
                get() {
                  throw new Error("model id read failed");
                },
              }),
              makeModel("healthy-model"),
            ],
          }),
        },
      },
      expected: {
        healthy: {
          baseUrl: "http://healthy.example/v1",
          models: [makeModel("healthy-model")],
        },
      },
    },
    {
      name: "keeps minimal model rows with id-only labels",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          healthy: makeModelProviderConfig({
            baseUrl: "http://healthy.example/v1",
            models: [{ id: "local-tiny" } as ModelDefinitionConfig],
          }),
        },
      },
      expected: {
        healthy: {
          baseUrl: "http://healthy.example/v1",
          models: [{ id: "local-tiny", name: "local-tiny" }],
        },
      },
    },
  ];

  it.each(cases)("$name", ({ provider, result, expected }) => {
    expectNormalizedDiscoveryResult({ provider, result, expected });
  });
});

describe("runProviderStaticCatalog", () => {
  it("runs static catalogs with a sterile context", async () => {
    const seenContexts: unknown[] = [];
    const provider: ProviderPlugin = {
      id: "demo",
      label: "Demo",
      auth: [],
      staticCatalog: {
        run: async (ctx) => {
          seenContexts.push(ctx);
          return {
            provider: makeModelProviderConfig({ baseUrl: "https://static.example/v1" }),
          };
        },
      },
    };

    await expect(runProviderStaticCatalog({ provider })).resolves.toEqual({
      provider: {
        baseUrl: "https://static.example/v1",
        models: [],
      },
    });

    expect(seenContexts).toHaveLength(1);
    const sterileContext = seenContexts[0] as {
      config: Record<string, never>;
      env: Record<string, never>;
      resolveProviderApiKey: () => { apiKey: string | undefined };
      resolveProviderAuth: () => {
        apiKey: string | undefined;
        mode: "none";
        source: "none";
      };
    };
    expect(sterileContext).toEqual({
      config: {},
      env: {},
      resolveProviderApiKey: sterileContext.resolveProviderApiKey,
      resolveProviderAuth: sterileContext.resolveProviderAuth,
    });
    expect(sterileContext.resolveProviderApiKey()).toEqual({ apiKey: undefined });
    expect(sterileContext.resolveProviderAuth()).toEqual({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
    expect(seenContexts[0]).not.toHaveProperty("agentDir");
    expect(seenContexts[0]).not.toHaveProperty("workspaceDir");
  });
});
