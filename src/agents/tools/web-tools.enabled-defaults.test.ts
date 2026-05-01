import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { clearActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

vi.mock("../../web-search/runtime.js", async () => {
  const { getActivePluginRegistry } = await import("../../plugins/runtime.js");
  const resolveRuntimeDefinition = (options?: {
    config?: unknown;
    runtimeWebSearch?: { selectedProvider?: string; providerConfigured?: string };
  }) => {
    const providerId =
      options?.runtimeWebSearch?.selectedProvider ?? options?.runtimeWebSearch?.providerConfigured;
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
      args: Record<string, unknown>;
      runtimeWebSearch?: unknown;
    }) => {
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
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
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
});
