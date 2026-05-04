import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "../../secrets/runtime-web-tools-state.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

const runWebSearchCalls = vi.hoisted(
  () =>
    [] as Array<{
      config?: unknown;
      preferRuntimeProviders?: boolean;
      runtimeWebSearch?: unknown;
    }>,
);
const activeSecretsRuntimeSnapshot = vi.hoisted(() => ({
  current: null as null | { config: unknown },
}));

function readConfiguredSearchProvider(config: unknown): string | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const tools = (config as { tools?: unknown }).tools;
  if (!tools || typeof tools !== "object") {
    return undefined;
  }
  const web = (tools as { web?: unknown }).web;
  if (!web || typeof web !== "object") {
    return undefined;
  }
  const search = (web as { search?: unknown }).search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const provider = (search as { provider?: unknown }).provider;
  return typeof provider === "string" ? provider : undefined;
}

vi.mock("../../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => activeSecretsRuntimeSnapshot.current,
}));

vi.mock("../../web-search/runtime.js", async () => {
  const { getActivePluginRegistry } = await import("../../plugins/runtime.js");
  const { getActiveRuntimeWebToolsMetadata } =
    await import("../../secrets/runtime-web-tools-state.js");
  const resolveRuntimeDefinition = (options?: {
    config?: unknown;
    runtimeWebSearch?: { selectedProvider?: string; providerConfigured?: string };
  }) => {
    const providerId =
      options?.runtimeWebSearch?.selectedProvider ??
      options?.runtimeWebSearch?.providerConfigured ??
      getActiveRuntimeWebToolsMetadata()?.search?.selectedProvider ??
      getActiveRuntimeWebToolsMetadata()?.search?.providerConfigured ??
      readConfiguredSearchProvider(options?.config);
    const registration = getActivePluginRegistry()?.webSearchProviders.find(
      (entry) => entry.provider.id === providerId,
    );
    const definition = registration?.provider.createTool({
      config: options?.config as never,
      runtimeMetadata: options?.runtimeWebSearch as never,
    });
    return registration && definition
      ? {
          provider: {
            ...registration.provider,
            pluginId: registration.pluginId,
          },
          definition,
        }
      : null;
  };
  return {
    resolveWebSearchDefinition: resolveRuntimeDefinition,
    resolveWebSearchProviderId: () => "",
    runWebSearch: async (options: {
      config?: unknown;
      args: Record<string, unknown>;
      preferRuntimeProviders?: boolean;
      runtimeWebSearch?: unknown;
    }) => {
      runWebSearchCalls.push({
        config: options.config,
        preferRuntimeProviders: options.preferRuntimeProviders,
        runtimeWebSearch: options.runtimeWebSearch,
      });
      const resolved = resolveRuntimeDefinition(options as never);
      if (!resolved) {
        throw new Error("web_search is disabled or no provider is available.");
      }
      return {
        provider: resolved.provider.id,
        result: await resolved.definition.execute(options.args),
      };
    },
  };
});

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
  activeSecretsRuntimeSnapshot.current = null;
  runWebSearchCalls.length = 0;
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
  activeSecretsRuntimeSnapshot.current = null;
});

describe("web tools defaults", () => {
  it("enables web_fetch by default (non-sandbox)", () => {
    const tool = createWebFetchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("web_fetch");
  });

  it("disables web_fetch when explicitly disabled", () => {
    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { enabled: false } } } },
      sandboxed: false,
    });
    expect(tool).toBeNull();
  });

  it("uses runtime-only web_search providers when runtime metadata is present", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      source: "test",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        autoDetectOrder: 1,
        credentialPath: "tools.web.search.custom.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom runtime tool",
          parameters: {},
          execute: async () => ({ ok: true }),
        }),
      },
    });
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      sandboxed: true,
      runtimeWebSearch: {
        providerConfigured: "custom",
        providerSource: "configured",
        selectedProvider: "custom",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    const result = await tool?.execute?.("call-runtime-provider", {});

    expect(tool?.description).toContain("Search the web");
    expect(result?.details).toMatchObject({ ok: true });
  });

  it("keeps runtime provider discovery enabled when runtime web_search metadata is missing", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      source: "test",
      provider: {
        id: "custom",
        label: "Custom Search",
        hint: "Custom runtime provider",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        placeholder: "custom-...",
        signupUrl: "https://example.com/signup",
        autoDetectOrder: 1,
        credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "custom runtime tool",
          parameters: {},
          execute: async () => ({ provider: "custom" }),
        }),
      },
    });
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "custom",
            },
          },
        },
      },
      sandboxed: true,
    });

    const result = await tool?.execute?.("call-runtime-provider-without-metadata", {});

    expect(result?.details).toMatchObject({ provider: "custom" });
    expect(runWebSearchCalls).toHaveLength(1);
    expect(runWebSearchCalls[0]?.preferRuntimeProviders).toBe(true);
  });

  it("late-binds managed web_search execution to the current runtime snapshot", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push(
      {
        pluginId: "stale-search",
        pluginName: "Stale Search",
        source: "test",
        provider: {
          id: "stale",
          label: "Stale Search",
          hint: "Stale runtime provider",
          envVars: [],
          placeholder: "stale-...",
          signupUrl: "https://example.com/stale",
          autoDetectOrder: 1,
          credentialPath: "tools.web.search.stale.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => ({
            description: "stale runtime tool",
            parameters: {},
            execute: async () => ({ provider: "stale" }),
          }),
        },
      },
      {
        pluginId: "fresh-search",
        pluginName: "Fresh Search",
        source: "test",
        provider: {
          id: "fresh",
          label: "Fresh Search",
          hint: "Fresh runtime provider",
          envVars: [],
          placeholder: "fresh-...",
          signupUrl: "https://example.com/fresh",
          autoDetectOrder: 2,
          credentialPath: "tools.web.search.fresh.apiKey",
          getCredentialValue: () => "configured",
          setCredentialValue: () => {},
          createTool: () => ({
            description: "fresh runtime tool",
            parameters: {},
            execute: async () => ({ provider: "fresh" }),
          }),
        },
      },
    );
    setActivePluginRegistry(registry);
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "fresh",
        providerSource: "configured",
        selectedProvider: "fresh",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });
    const runtimeConfig = {
      tools: { web: { search: { provider: "fresh", fresh: { apiKey: "runtime-key" } } } },
    };
    activeSecretsRuntimeSnapshot.current = { config: runtimeConfig };

    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "stale" } } } },
      sandboxed: true,
      runtimeWebSearch: {
        providerConfigured: "stale",
        providerSource: "configured",
        selectedProvider: "stale",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
      lateBindRuntimeConfig: true,
    });

    const result = await tool?.execute?.("call-runtime-provider", {});

    expect(result?.details).toMatchObject({ provider: "fresh" });
    expect(runWebSearchCalls).toHaveLength(1);
    expect(runWebSearchCalls[0]?.config).toBe(runtimeConfig);
    expect(runWebSearchCalls[0]?.runtimeWebSearch).toMatchObject({
      selectedProvider: "fresh",
    });
  });
});
