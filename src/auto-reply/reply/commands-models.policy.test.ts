import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { buildPreparedModelsProviderData } from "./commands-models.js";

const modelCatalogMocks = vi.hoisted(() => ({ loadModelCatalog: vi.fn() }));
const modelProviderAuthMocks = vi.hoisted(() => ({
  authenticatedProviders: new Set<string>(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  getPreparedModelCatalogOwnerSnapshot: () => undefined,
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  withPreparedModelCatalogOwner: async (params: unknown, read: (owner: object) => unknown) => {
    const entries = await modelCatalogMocks.loadModelCatalog(params);
    return read({
      modelCatalog: { entries, routeVariants: entries },
      authModes: {},
      isCurrent: () => true,
    });
  },
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: () => {
    const hasAuth = (provider: string) =>
      modelProviderAuthMocks.authenticatedProviders.has(provider);
    return Object.assign(hasAuth, {
      evaluateModelAuth: async (provider: string) => ({
        availability: hasAuth(provider),
        routeResolution: null,
      }),
    });
  },
  hasAuthForModelProvider: ({ provider }: { provider: string }) =>
    modelProviderAuthMocks.authenticatedProviders.has(provider),
  getCurrentProviderAuthState: () => null,
  clearCurrentProviderAuthState: () => undefined,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => undefined,
}));

beforeEach(() => {
  vi.useFakeTimers();
  modelCatalogMocks.loadModelCatalog.mockReset();
  setActivePluginRegistry(createTestRegistry([]));
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  cliBackendsTesting.resetDepsForTest();
});

describe("CLI model visibility policy", () => {
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    expected: string[];
    view?: "all";
  }>([
    {
      name: "explicit provider wildcards",
      cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } },
      expected: [],
    },
    {
      name: "explicit exact refs",
      cfg: {
        agents: { defaults: { modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] } } },
      },
      expected: [],
    },
    {
      name: "one explicitly allowed CLI model",
      cfg: {
        agents: { defaults: { modelPolicy: { allow: ["claude-cli/claude-sonnet-4-6"] } } },
      },
      expected: ["claude-sonnet-4-6"],
    },
    {
      name: "curated CLI provider wildcards",
      cfg: { agents: { defaults: { modelPolicy: { allow: ["claude-cli/*"] } } } },
      expected: ["claude-sonnet-4-6"],
    },
    {
      name: "an explicitly pinned deprecated CLI model",
      cfg: {
        agents: { defaults: { modelPolicy: { allow: ["claude-cli/claude-opus-4-6"] } } },
      },
      expected: ["claude-opus-4-6"],
    },
    {
      name: "an excluded CLI primary",
      cfg: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-sonnet-4-6" },
            modelPolicy: { allow: ["anthropic/*"] },
          },
        },
      },
      expected: [],
    },
    {
      name: "an excluded CLI fallback under provider wildcards",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["claude-cli/claude-sonnet-4-6"],
            },
            modelPolicy: { allow: ["anthropic/*"] },
          },
        },
      },
      expected: [],
    },
    {
      name: "configured CLI fallback retention under exact refs",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["claude-cli/claude-sonnet-4-6"],
            },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
          },
        },
      },
      expected: ["claude-sonnet-4-6"],
    },
    {
      name: "an agent-specific restriction",
      cfg: {
        agents: {
          defaults: { modelPolicy: { allow: [] } },
          entries: { main: { modelPolicy: { allow: ["anthropic/*"] } } },
        },
      },
      expected: [],
    },
    {
      name: "an unrestricted agent override",
      cfg: {
        agents: {
          defaults: { modelPolicy: { allow: ["anthropic/*"] } },
          entries: { main: { modelPolicy: { allow: [] } } },
        },
      },
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "an empty explicit allowlist",
      cfg: { agents: { defaults: { modelPolicy: { allow: [] } } } },
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "legacy provider wildcards",
      cfg: { agents: { defaults: { models: { "anthropic/*": {} } } } },
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "explicit all browse despite a restrictive policy",
      cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } },
      view: "all",
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
  ])("honors $name when listing CLI runtime models", async ({ cfg, expected, view }) => {
    modelCatalogMocks.loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet (CLI)" },
      {
        provider: "claude-cli",
        id: "claude-opus-4-6",
        name: "Claude Opus (CLI)",
        status: "deprecated",
      },
    ]);
    modelProviderAuthMocks.authenticatedProviders = new Set(["anthropic", "claude-cli"]);
    const config: OpenClawConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          ...cfg.agents?.defaults,
        },
      },
    };
    const originalConfig = structuredClone(config);

    const data = await buildPreparedModelsProviderData(config, "main", { view });

    expect([...(data.byProvider.get("claude-cli") ?? [])].toSorted()).toEqual(expected);
    expect(config).toEqual(originalConfig);
  });
});
