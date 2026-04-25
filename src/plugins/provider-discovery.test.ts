import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import type { PluginCandidate } from "./discovery.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolveInstalledPluginProviderContributionIds,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import type { ProviderCatalogResult, ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-provider-discovery", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createProviderContributionCandidate(params: {
  pluginId?: string;
  providerIds?: readonly string[];
}): PluginCandidate {
  const rootDir = makeTempDir();
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime provider entry should not load for cold contribution ids');\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId ?? "demo",
      configSchema: { type: "object" },
      providers: params.providerIds ?? ["demo"],
    }),
    "utf-8",
  );
  return {
    idHint: params.pluginId ?? "demo",
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderDiscoveryOrder;
  mode?: "catalog" | "discovery";
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
    ...(params.mode === "discovery" ? { discovery: hook } : { catalog: hook }),
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function expectGroupedProviderIds(
  providers: readonly ProviderPlugin[],
  expected: Record<ProviderDiscoveryOrder | "late", readonly string[]>,
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

function createCatalogRuntimeContext() {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function createCatalogProvider(params: {
  id?: string;
  catalogRun?: () => Promise<ProviderCatalogResult>;
  discoveryRun?: () => Promise<ProviderCatalogResult>;
}) {
  return {
    id: params.id ?? "demo",
    label: "Demo",
    auth: [],
    ...(params.catalogRun ? { catalog: { run: params.catalogRun } } : {}),
    ...(params.discoveryRun ? { discovery: { run: params.discoveryRun } } : {}),
  };
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

async function expectProviderCatalogResult(params: {
  provider: ProviderPlugin;
  expected: Record<string, unknown>;
}) {
  await expect(
    runProviderCatalog({
      provider: params.provider,
      ...createCatalogRuntimeContext(),
    }),
  ).resolves.toEqual(params.expected);
}

describe("resolveInstalledPluginProviderContributionIds", () => {
  it("reads provider ids from the installed plugin index without importing runtime entries", () => {
    const candidate = createProviderContributionCandidate({
      pluginId: "demo",
      providerIds: ["demo", "demo-alias"],
    });

    expect(
      resolveInstalledPluginProviderContributionIds({
        candidates: [candidate],
        env: hermeticEnv(),
      }),
    ).toEqual(["demo", "demo-alias"]);
  });

  it("omits disabled plugin provider ids unless explicitly requested", () => {
    const candidate = createProviderContributionCandidate({
      pluginId: "demo",
      providerIds: ["demo"],
    });
    const params = {
      candidates: [candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    };

    expect(resolveInstalledPluginProviderContributionIds(params)).toEqual([]);
    expect(
      resolveInstalledPluginProviderContributionIds({
        ...params,
        includeDisabled: true,
      }),
    ).toEqual(["demo"]);
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
    {
      name: "uses the legacy discovery hook when catalog is absent",
      providers: [
        makeProvider({ id: "legacy", label: "Legacy", order: "profile", mode: "discovery" }),
      ],
      expected: {
        simple: [],
        profile: ["legacy"],
        paired: [],
        late: [],
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

    expect(seenContexts).toEqual([
      expect.objectContaining({
        config: {},
        env: {},
      }),
    ]);
    expect(seenContexts[0]).not.toHaveProperty("agentDir");
    expect(seenContexts[0]).not.toHaveProperty("workspaceDir");
  });
});

describe("runProviderCatalog", () => {
  it("prefers catalog over discovery when both exist", async () => {
    const catalogRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://catalog.example/v1" }),
    });
    const discoveryRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://discovery.example/v1" }),
    });

    await expectProviderCatalogResult({
      provider: createCatalogProvider({
        catalogRun,
        discoveryRun,
      }),
      expected: {
        provider: {
          baseUrl: "http://catalog.example/v1",
          models: [],
        },
      },
    });
  });
});
