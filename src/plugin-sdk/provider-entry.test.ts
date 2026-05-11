import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import type { ProviderCatalogContext } from "../plugins/types.js";
import { defineSingleProviderPluginEntry } from "./provider-entry.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
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
function createCatalogContext(
  config: ProviderCatalogContext["config"] = {},
): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

async function captureProviderEntry(params: {
  entry: ReturnType<typeof defineSingleProviderPluginEntry>;
  config?: ProviderCatalogContext["config"];
}) {
  const captured = capturePluginRegistration(params.entry);
  const provider = captured.providers[0];
  const modelCatalogProvider = captured.modelCatalogProviders[0];
  const catalog = await provider?.catalog?.run(createCatalogContext(params.config));
  const staticCatalog = await provider?.staticCatalog?.run(createCatalogContext(params.config));
  const unifiedCatalog = await modelCatalogProvider?.liveCatalog?.(
    createCatalogContext(params.config),
  );
  const unifiedStaticCatalog = await modelCatalogProvider?.staticCatalog?.(
    createCatalogContext(params.config),
  );
  return { captured, provider, catalog, staticCatalog, unifiedCatalog, unifiedStaticCatalog };
}

describe("defineSingleProviderPluginEntry", () => {
  it("registers a single provider with default wizard metadata", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        auth: [
          {
            methodId: "api-key",
            label: "Demo API key",
            hint: "Shared key",
            optionKey: "demoApiKey",
            flagName: "--demo-api-key",
            envVar: "DEMO_API_KEY",
            promptMessage: "Enter Demo API key",
            defaultModel: "demo/default",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.demo.test/v1",
            models: [createModel("default", "Default")],
          }),
          buildStaticProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.demo.test/v1",
            models: [createModel("default", "Default")],
          }),
        },
      },
    });

    const { captured, provider, catalog, staticCatalog, unifiedCatalog, unifiedStaticCatalog } =
      await captureProviderEntry({ entry });
    expect(captured.providers).toHaveLength(1);
    expect(captured.modelCatalogProviders).toHaveLength(1);
    expect(provider?.id).toBe("demo");
    expect(provider?.label).toBe("Demo");
    expect(provider?.docsPath).toBe("/providers/demo");
    expect(provider?.envVars).toEqual(["DEMO_API_KEY"]);
    expect(provider?.auth).toHaveLength(1);
    expect(provider?.auth[0]?.id).toBe("api-key");
    expect(provider?.auth[0]?.label).toBe("Demo API key");
    expect(provider?.auth[0]?.hint).toBe("Shared key");
    expect(provider?.auth[0]?.wizard?.choiceId).toBe("demo-api-key");
    expect(provider?.auth[0]?.wizard?.choiceLabel).toBe("Demo API key");
    expect(provider?.auth[0]?.wizard?.groupId).toBe("demo");
    expect(provider?.auth[0]?.wizard?.groupLabel).toBe("Demo");
    expect(provider?.auth[0]?.wizard?.groupHint).toBe("Shared key");
    expect(provider?.auth[0]?.wizard?.methodId).toBe("api-key");

    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://api.demo.test/v1",
        models: [createModel("default", "Default")],
      },
    });
    expect(staticCatalog).toEqual({
      provider: {
        api: "openai-completions",
        baseUrl: "https://api.demo.test/v1",
        models: [createModel("default", "Default")],
      },
    });
    expect(unifiedCatalog).toEqual([
      {
        kind: "text",
        provider: "demo",
        model: "default",
        label: "Default",
        source: "live",
      },
    ]);
    expect(unifiedStaticCatalog).toEqual([
      {
        kind: "text",
        provider: "demo",
        model: "default",
        label: "Default",
        source: "static",
      },
    ]);
  });

  it("supports provider overrides, explicit env vars, and extra registration", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "gateway-plugin",
      name: "Gateway Provider",
      description: "Gateway provider plugin",
      provider: {
        id: "gateway",
        label: "Gateway",
        aliases: ["gw"],
        docsPath: "/providers/gateway",
        envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
        auth: [
          {
            methodId: "api-key",
            label: "Gateway key",
            hint: "Primary key",
            optionKey: "gatewayKey",
            flagName: "--gateway-key",
            envVar: "GATEWAY_KEY",
            promptMessage: "Enter Gateway key",
            wizard: {
              groupId: "shared-gateway",
              groupLabel: "Shared Gateway",
            },
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://gateway.test/v1",
            models: [createModel("router", "Router")],
          }),
          allowExplicitBaseUrl: true,
        },
        capabilities: {
          transcriptToolCallIdMode: "strict9",
        },
      },
      register(api) {
        api.registerWebSearchProvider({
          id: "gateway-search",
          label: "Gateway Search",
          hint: "search",
          envVars: [],
          placeholder: "",
          signupUrl: "https://example.com",
          credentialPath: "tools.web.search.gateway.apiKey",
          getCredentialValue: () => undefined,
          setCredentialValue() {},
          createTool: () => ({
            description: "search",
            parameters: {},
            execute: async () => ({}),
          }),
        });
      },
    });

    const { captured, provider, catalog } = await captureProviderEntry({
      entry,
      config: {
        models: {
          providers: {
            gateway: {
              baseUrl: "https://override.test/v1",
              models: [createModel("router", "Router")],
            },
          },
        },
      },
    });
    expect(captured.providers).toHaveLength(1);
    expect(captured.modelCatalogProviders).toHaveLength(1);
    expect(captured.webSearchProviders).toHaveLength(1);

    expect(provider?.id).toBe("gateway");
    expect(provider?.label).toBe("Gateway");
    expect(provider?.aliases).toEqual(["gw"]);
    expect(provider?.envVars).toEqual(["GATEWAY_KEY", "SECONDARY_KEY"]);
    expect(provider?.capabilities?.transcriptToolCallIdMode).toBe("strict9");
    expect(provider?.auth[0]?.wizard?.choiceId).toBe("gateway-api-key");
    expect(provider?.auth[0]?.wizard?.groupId).toBe("shared-gateway");
    expect(provider?.auth[0]?.wizard?.groupLabel).toBe("Shared Gateway");
    expect(provider?.auth[0]?.wizard?.groupHint).toBe("Primary key");

    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://override.test/v1",
        models: [createModel("router", "Router")],
      },
    });
  });
});
