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

type WebSearchProviderResolverParams = {
  bundledAllowlistCompat?: boolean;
  config?: OpenClawConfig;
  onlyPluginIds?: readonly string[];
  origin?: string;
};

type ManifestContractOwnerParams = {
  config?: OpenClawConfig;
  contract?: string;
  origin?: string;
  value?: string;
};

const {
  resolveManifestContractOwnerPluginIdMock,
  resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProvidersMock,
} = vi.hoisted(() => ({
  resolveManifestContractOwnerPluginIdMock: vi.fn(
    (_params: ManifestContractOwnerParams): string | undefined => undefined,
  ),
  resolvePluginWebSearchProvidersMock: vi.fn(
    (_params?: WebSearchProviderResolverParams): PluginWebSearchProviderEntry[] => [],
  ),
  resolveRuntimeWebSearchProvidersMock: vi.fn(
    (_params?: WebSearchProviderResolverParams): PluginWebSearchProviderEntry[] => [],
  ),
}));

vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
}));

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
    resolveManifestContractOwnerPluginIdMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
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
        requiresCredential: false,
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

  it("passes the run abort signal to provider execution", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => ({
        ...args,
        aborted: context?.signal?.aborted ?? false,
        sameSignal: context?.signal === controller.signal,
      }),
    );
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        requiresCredential: false,
        createTool: () => ({
          description: "custom",
          parameters: {},
          execute,
        }),
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "abort plumbing" },
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "abort plumbing", aborted: false, sameSignal: true },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: "abort plumbing" },
      { signal: controller.signal },
    );
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

  it("auto-detects a provider from a configured credential fallback", async () => {
    const provider = createCustomSearchProvider({
      getConfiguredCredentialFallback: (config) => {
        const modelProvider = config?.models?.providers?.["custom-search"];
        return modelProvider && typeof modelProvider === "object" && "apiKey" in modelProvider
          ? {
              path: "models.providers.custom-search.apiKey",
              value: (modelProvider as { apiKey?: unknown }).apiKey,
            }
          : undefined;
      },
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      provider,
      createDuckDuckGoSearchProvider(),
    ]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([
      provider,
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {
          models: {
            providers: {
              "custom-search": {
                apiKey: "custom-provider-key",
                baseUrl: "https://custom-search.example/v1",
                models: [],
              },
            },
          },
        },
        args: { query: "fallback" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "fallback", ok: true },
    });
  });

  it("uses the active resolved runtime config for matching source config callers", async () => {
    const provider = createCustomSearchProvider({
      createTool: ({ config }) => ({
        description: "custom",
        parameters: {},
        execute: async (args) => ({
          ...args,
          apiKey: getCustomSearchApiKey(config),
        }),
      }),
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const sourceConfig = createCustomSearchConfig({
      source: "exec",
      provider: "mockexec",
      id: "custom-search/api-key",
    });
    const resolvedConfig = createCustomSearchConfig("resolved-custom-key");

    activateSecretsRuntimeSnapshot({
      sourceConfig,
      config: resolvedConfig,
      authStores: [],
      warnings: [],
      webTools: {
        search: {
          providerSource: "auto-detect",
          selectedProvider: "custom",
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
        config: structuredClone(sourceConfig),
        args: { query: "runtime-source" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: {
        query: "runtime-source",
        apiKey: "resolved-custom-key",
      },
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
        requiresCredential: false,
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

  it("falls back when an auto-selected provider returns a structured error payload", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        requiresCredential: false,
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => ({
            error: "missing_google_api_key",
            message: "google key missing",
          }),
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback-structured-error" },
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { query: "fallback-structured-error", provider: "duckduckgo" },
    });
  });

  it("does not fall back when an auto-selected provider returns a validation error payload", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        requiresCredential: false,
        createTool: () => ({
          description: "google",
          parameters: {},
          execute: async () => ({
            error: "invalid_freshness",
            message: "freshness must be day, week, month, or year.",
          }),
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        config: {},
        args: { query: "fallback-validation-error", freshness: "forever" },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: {
        error: "invalid_freshness",
        message: "freshness must be day, week, month, or year.",
      },
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

  it("scopes runtime provider loading to the configured bundled web_search provider", async () => {
    resolveManifestContractOwnerPluginIdMock.mockImplementation(({ value }) =>
      value === "duckduckgo" ? "duckduckgo" : undefined,
    );
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([createDuckDuckGoSearchProvider()]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "duckduckgo",
              },
            },
          },
        },
        args: { query: "configured-duck" },
      }),
    ).resolves.toMatchObject({
      provider: "duckduckgo",
    });

    expect(resolveManifestContractOwnerPluginIdMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webSearchProviders",
        origin: "bundled",
        value: "duckduckgo",
      }),
    );
    expect(resolveRuntimeWebSearchProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["duckduckgo"],
      }),
    );
  });

  it("scopes runtime provider loading through manifest ownership when provider id differs from plugin id", async () => {
    resolveManifestContractOwnerPluginIdMock.mockImplementation(({ value }) =>
      value === "gemini" ? "google" : undefined,
    );
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        id: "gemini",
        pluginId: "google",
      }),
    ]);

    await expect(
      runWebSearch({
        config: {},
        runtimeWebSearch: {
          providerConfigured: "gemini",
          selectedProvider: "gemini",
          providerSource: "configured",
          diagnostics: [],
        },
        args: { query: "configured-gemini" },
      }),
    ).resolves.toMatchObject({
      provider: "gemini",
    });

    expect(resolveRuntimeWebSearchProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["google"],
      }),
    );
  });

  it("keeps runtime provider loading unscoped when configured provider ownership is unknown", async () => {
    resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        id: "external-search",
        pluginId: "external-search",
        requiresCredential: false,
      }),
    ]);

    await expect(
      runWebSearch({
        config: {
          tools: {
            web: {
              search: {
                provider: "external-search",
              },
            },
          },
        },
        args: { query: "external-provider" },
      }),
    ).resolves.toMatchObject({
      provider: "external-search",
    });

    expect(resolveRuntimeWebSearchProvidersMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
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
