import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import {
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

const { resolvePluginWebSearchProvidersMock, resolveRuntimeWebSearchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
    resolveRuntimeWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
  }),
);

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createCustomSearchTool() {
  return {
    description: "custom",
    parameters: {},
    execute: async (args: Record<string, unknown>) => ({ ...args, ok: true }),
  };
}

function getCustomSearchApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
    | TestPluginWebSearchConfig
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function createCustomSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "custom-search",
    id: "custom",
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    autoDetectOrder: 1,
    getConfiguredCredentialValue: getCustomSearchApiKey,
    createTool: createCustomSearchTool,
    ...overrides,
  });
}

function createCustomSearchConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "custom-search": {
          enabled: true,
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

function createGoogleSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "google",
    id: "google",
    credentialPath: "tools.web.search.google.apiKey",
    autoDetectOrder: 1,
    getCredentialValue: () => "configured",
    ...overrides,
  });
}

function createDuckDuckGoSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    pluginId: "duckduckgo",
    id: "duckduckgo",
    credentialPath: "",
    autoDetectOrder: 100,
    requiresCredential: false,
    ...overrides,
  });
}

describe("web search runtime", () => {
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("executes searches through the active plugin registry", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        getCredentialValue: () => "configured",
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("auto-detects a provider from canonical plugin-owned credentials", async () => {
    const provider = createCustomSearchProvider();
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config = createCustomSearchConfig("custom-config-key");

    await expect(
      runWebSearch({
        config,
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("treats non-env SecretRefs as configured credentials for provider auto-detect", async () => {
    const provider = createCustomSearchProvider();
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config = createCustomSearchConfig({
      source: "file",
      provider: "vault",
      id: "/providers/custom-search/apiKey",
    });

    await expect(
      runWebSearch({
        config,
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", ok: true },
    });
  });

  it("falls back to a keyless provider when no credentials are available", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createDuckDuckGoSearchProvider({
        getCredentialValue: () => "duckduckgo-no-key-needed",
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { query: "fallback", provider: "duckduckgo" },
    });
  });

  it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "alpha-search",
        id: "alpha",
        credentialPath: "tools.web.search.alpha.apiKey",
        autoDetectOrder: 1,
        getCredentialValue: () => "alpha-configured",
        createTool: ({ runtimeMetadata }) => ({
          description: "alpha",
          parameters: {},
          execute: async (args) => ({
            ...args,
            provider: "alpha",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
        }),
      }),
      createWebSearchTestProvider({
        pluginId: "beta-search",
        id: "beta",
        credentialPath: "tools.web.search.beta.apiKey",
        autoDetectOrder: 2,
        getCredentialValue: () => "beta-configured",
        createTool: ({ runtimeMetadata }) => ({
          description: "beta",
          parameters: {},
          execute: async (args) => ({
            ...args,
            provider: "beta",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
        }),
      }),
    ]);

    activateSecretsRuntimeSnapshot({
      sourceConfig: {},
      config: {},
      authStores: [],
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "beta",
          diagnostics: [],
        },
        fetch: {
          providerSource: "none",
          diagnostics: [],
        },
        diagnostics: [],
      },
    });

    await expect(
      runWebSearch({
        config: {},
        args: { query: "runtime" },
      }),
    ).resolves.toEqual({
      provider: "beta",
      result: { query: "runtime", provider: "beta", runtimeSelectedProvider: "beta" },
    });
  });

  it("falls back to another provider when auto-selected search execution fails", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { query: "fallback", provider: "duckduckgo" },
    });
  });

  it("does not prebuild fallback provider tools before attempting the selected provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider(),
      createWebSearchTestProvider({
        pluginId: "broken-fallback",
        id: "broken-fallback",
        credentialPath: "",
        autoDetectOrder: 100,
        requiresCredential: false,
        createTool: () => {
          throw new Error("fallback createTool exploded");
        },
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "selected-first" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { query: "selected-first", provider: "google" },
    });
  });

  it("does not fall back when the provider came from explicit config selection", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
              },
            },
          },
        },
        args: { query: "configured" },
      }),
    ).rejects.toThrow("google aborted");
  });

  it("does not fall back when the caller explicitly selects a provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => {
            throw new Error("google aborted");
          },
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "google",
        args: { query: "explicit" },
      }),
    ).rejects.toThrow("google aborted");
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "google",
        args: { query: "explicit-null-tool" },
      }),
    ).rejects.toThrow('web_search provider "google" is not available.');
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider(),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        providerId: "missing-id",
        args: { query: "explicit-missing" },
      }),
    ).rejects.toThrow('Unknown web_search provider "missing-id".');
  });

  it("still falls back when config names an unknown provider id", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => {
          throw new Error("google aborted");
        },
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "missing-id",
              },
            },
          },
        },
        args: { query: "config-typo" },
      }),
    ).resolves.toMatchObject({
      provider: "duckduckgo",
      result: expect.objectContaining({
        provider: "duckduckgo",
        query: "config-typo",
      }),
    });
  });

  it("honors preferRuntimeProviders during execution", async () => {
    const configuredProvider = createGoogleSearchProvider();
    const runtimeProvider = createWebSearchTestProvider({
      pluginId: "runtime-search",
      id: "runtime-search",
      credentialPath: "",
      autoDetectOrder: 0,
      requiresCredential: false,
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([configuredProvider, runtimeProvider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([configuredProvider]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
              },
            },
          },
        },
        runtimeWebSearch: {
          providerConfigured: "runtime-search",
          selectedProvider: "runtime-search",
          providerSource: "configured",
          diagnostics: [],
        },
        preferRuntimeProviders: false,
        args: { query: "prefer-config" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { query: "prefer-config", provider: "google" },
    });
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider({
        createTool: () => null,
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "all-null-tools" },
      }),
    ).rejects.toThrow("web_search is enabled but no provider is currently available.");
  });
});
