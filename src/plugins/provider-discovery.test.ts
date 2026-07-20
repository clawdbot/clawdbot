/** Tests provider discovery normalization, grouping, and manifest contribution handling. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import * as providerDiscoveryModule from "./provider-discovery.js";
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

describe("resolveInstalledPluginProviderContributionIds", () => {
  it("keeps current production callers off the ambiguous runtime-discovery alias", () => {
    const callerPaths = [
      "src/agents/models-config.providers.implicit.ts",
      "src/commands/models/list.provider-catalog.ts",
    ];

    for (const callerPath of callerPaths) {
      expect(fs.readFileSync(path.join(process.cwd(), callerPath), "utf-8")).not.toContain(
        "resolvePluginDiscoveryProviders",
      );
    }
  });

  it("does not keep exporting the ambiguous runtime-discovery alias", () => {
    expect(Object.keys(providerDiscoveryModule)).not.toContain("resolvePluginDiscoveryProviders");
  });
});

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

    await expect(
      runProviderStaticCatalog({
        provider,
        config: {
          models: {
            providers: {
              demo: {
                baseUrl: "https://configured.example/v1",
                models: [],
                apiKey: "secret-value",
              },
            },
          },
        },
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        env: {
          SECRET_TOKEN: "secret-value",
        },
      }),
    ).resolves.toEqual({
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
