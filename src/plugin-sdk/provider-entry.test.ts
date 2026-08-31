// Provider entry tests cover provider plugin entry contracts and catalog integration.
import { describe, expect, it, vi } from "vitest";
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

function createProviderManifest() {
  return {
    setup: { providers: [{ id: "demo", envVars: ["DEMO_API_KEY"] }] },
    providerAuthChoices: [
      {
        provider: "demo",
        method: "api-key",
        choiceId: "demo-api-key",
        choiceLabel: "Demo API key",
        choiceHint: "Manifest-owned key",
        groupId: "demo-group",
        groupLabel: "Demo providers",
        groupHint: "Manifest-owned setup",
        optionKey: "demoApiKey",
        cliFlag: "--demo-api-key",
      },
    ],
    modelCatalog: {
      providers: {
        demo: {
          api: "openai-completions",
          baseUrl: "https://api.demo.test/v1",
          defaultModel: "default",
          models: [createModel("default", "Default")],
        },
      },
    },
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
  it("keeps static catalog registration independent of live discovery", async () => {
    const liveCatalog = {
      provider: { baseUrl: "https://api.demo.test/v1", models: [createModel("live", "Live")] },
    };
    const buildLiveCatalog = vi.fn(async () => liveCatalog);
    const loadLiveCatalog = vi.fn(() => ({
      buildOpenAICompatibleProviderCatalog: buildLiveCatalog,
    }));
    vi.doMock("../agents/provider-attribution.js", () => {
      throw new Error("Static provider entry loaded transport policy");
    });
    vi.doMock("./provider-catalog-live-runtime.js", loadLiveCatalog);
    vi.resetModules();
    try {
      const { defineSingleProviderPluginEntry: defineColdEntry } =
        await import("./provider-entry.js");
      const entry = defineColdEntry({
        id: "demo",
        name: "Demo Provider",
        description: "Demo provider plugin",
        manifest: createProviderManifest(),
        provider: {
          label: "Demo",
          docsPath: "/providers/demo",
          aliases: ["demo-alias"],
          catalog: { liveModelDiscovery: true },
        },
      });
      const provider = capturePluginRegistration(entry).providers[0];
      const context = createCatalogContext();
      await expect(provider?.staticCatalog?.run(context)).resolves.toMatchObject({
        provider: { models: [createModel("default", "Default")] },
      });
      await expect(provider?.catalog?.run({ ...context, providerIds: [] })).resolves.toBeNull();
      expect(loadLiveCatalog).not.toHaveBeenCalled();

      const scopedContext = { ...context, providerIds: ["demo-alias"] };
      await expect(provider?.catalog?.run(scopedContext)).resolves.toBe(liveCatalog);
      expect(buildLiveCatalog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ctx: scopedContext,
          providerId: "demo",
          providerAliases: ["demo-alias"],
        }),
      );
    } finally {
      vi.doUnmock("../agents/provider-attribution.js");
      vi.doUnmock("./provider-catalog-live-runtime.js");
      vi.resetModules();
    }
  });

  it("derives API-key auth and static and live model catalogs from the provider manifest", async () => {
    const manifest = createProviderManifest();
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest,
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        aliases: ["demo-alias"],
        catalog: {},
      },
    });

    const { provider, catalog, staticCatalog, unifiedCatalog, unifiedStaticCatalog } =
      await captureProviderEntry({ entry });

    expect(provider).toMatchObject({
      id: "demo",
      label: "Demo",
      aliases: ["demo-alias"],
      envVars: ["DEMO_API_KEY"],
    });
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "Demo API key",
      hint: "Manifest-owned key",
      starterModel: "demo/default",
      wizard: {
        choiceId: "demo-api-key",
        choiceLabel: "Demo API key",
        choiceHint: "Manifest-owned key",
        groupId: "demo-group",
        groupLabel: "Demo providers",
        groupHint: "Manifest-owned setup",
        methodId: "api-key",
      },
    });
    const { defaultModel, ...manifestProvider } = manifest.modelCatalog.providers.demo;
    expect(defaultModel).toBe("default");
    expect(catalog).toEqual({ provider: { ...manifestProvider, apiKey: "test-key" } });
    expect(staticCatalog).toEqual({ provider: manifestProvider });
    expect(unifiedCatalog).toEqual([
      { kind: "text", provider: "demo", model: "default", label: "Default", source: "live" },
    ]);
    expect(unifiedStaticCatalog).toEqual([
      { kind: "text", provider: "demo", model: "default", label: "Default", source: "static" },
    ]);
  });

  it("gates generated catalogs by canonical and alias provider identities before auth", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: createProviderManifest(),
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        aliases: ["demo-alias"],
        catalog: {},
      },
    });
    const provider = capturePluginRegistration(entry).providers[0];
    let resolveProviderApiKeyCalls = 0;
    const resolveProviderApiKey = () => {
      resolveProviderApiKeyCalls += 1;
      return { apiKey: "test-key" };
    };
    const context = { ...createCatalogContext(), resolveProviderApiKey };

    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["demo-alias"] }),
    ).resolves.toMatchObject({ provider: { apiKey: "test-key" } });

    resolveProviderApiKeyCalls = 0;
    await expect(
      provider?.catalog?.run({ ...context, providerIds: ["other"] }),
    ).resolves.toBeNull();
    await expect(provider?.catalog?.run({ ...context, providerIds: [] })).resolves.toBeNull();
    expect(resolveProviderApiKeyCalls).toBe(0);
  });

  it("accepts an alias scope for generated live model discovery", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        aliases: ["demo-alias"],
        catalog: {
          liveModelDiscovery: true,
          buildProvider: () => ({
            baseUrl: "not-a-url",
            api: "openai-completions",
            models: [],
          }),
        },
      },
    });
    const provider = capturePluginRegistration(entry).providers[0];

    await expect(
      provider?.catalog?.run({ ...createCatalogContext(), providerIds: ["demo-alias"] }),
    ).resolves.toMatchObject({ provider: { apiKey: "test-key" } });
  });

  it("preserves manifest-owned onboarding scope and assistant metadata", () => {
    const manifest = createProviderManifest();
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: {
        ...manifest,
        providerAuthChoices: [
          {
            ...manifest.providerAuthChoices[0]!,
            assistantPriority: 4,
            assistantVisibility: "manual-only",
            onboardingFeatured: true,
            onboardingScopes: ["text-inference", "music-generation"],
          },
        ],
      },
      provider: { label: "Demo", docsPath: "/providers/demo", catalog: {} },
    });

    expect(capturePluginRegistration(entry).providers[0]?.auth[0]?.wizard).toMatchObject({
      assistantPriority: 4,
      assistantVisibility: "manual-only",
      onboardingFeatured: true,
      onboardingScopes: ["text-inference", "music-generation"],
    });
  });

  it("creates registration-scoped provider state for provider factories", () => {
    let registrations = 0;
    const registrationApis: unknown[] = [];
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: createProviderManifest(),
      provider(api) {
        registrationApis.push(api);
        const registration = ++registrations;
        return {
          label: "Demo",
          docsPath: "/providers/demo",
          catalog: {},
          normalizeModelId: ({ modelId }) => `${modelId}:${registration}`,
        };
      },
    });

    const firstRegistration = capturePluginRegistration(entry);
    const secondRegistration = capturePluginRegistration(entry);
    const first = firstRegistration.providers[0];
    const second = secondRegistration.providers[0];

    expect(first?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:1");
    expect(second?.normalizeModelId?.({ provider: "demo", modelId: "example" })).toBe("example:2");
    expect(registrationApis).toEqual([firstRegistration.api, secondRegistration.api]);
    expect(registrationApis[0]).not.toBe(registrationApis[1]);
    expect(registrations).toBe(2);
  });

  it("merges manifest onboarding metadata with provider-owned wizard model policies", () => {
    const manifest = createProviderManifest();
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: {
        ...manifest,
        providerAuthChoices: [
          {
            ...manifest.providerAuthChoices[0]!,
            assistantPriority: 4,
            assistantVisibility: "manual-only",
            onboardingFeatured: true,
            onboardingScopes: ["text-inference", "music-generation"],
          },
        ],
      },
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        manifestAuth: {
          wizard: {
            modelAllowlist: { allowedKeys: ["demo/default"], loadCatalog: true },
            modelSelection: { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false },
          },
        },
        catalog: {},
      },
    });

    expect(capturePluginRegistration(entry).providers[0]?.auth[0]?.wizard).toMatchObject({
      choiceId: "demo-api-key",
      choiceLabel: "Demo API key",
      choiceHint: "Manifest-owned key",
      groupId: "demo-group",
      groupLabel: "Demo providers",
      groupHint: "Manifest-owned setup",
      assistantPriority: 4,
      assistantVisibility: "manual-only",
      onboardingFeatured: true,
      onboardingScopes: ["text-inference", "music-generation"],
      methodId: "api-key",
      modelAllowlist: { allowedKeys: ["demo/default"], loadCatalog: true },
      modelSelection: { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false },
    });
  });

  it("allows provider-owned manifest auth to disable the onboarding wizard", () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: createProviderManifest(),
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        manifestAuth: { wizard: false },
        catalog: {},
      },
    });

    expect(capturePluginRegistration(entry).providers[0]?.auth[0]?.wizard).toBeUndefined();
  });

  it("honors explicit base URLs and provider-owned manifest auth overrides", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: createProviderManifest(),
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        manifestAuth: { defaultModel: "demo/custom", preserveExistingPrimary: true },
        catalog: { allowExplicitBaseUrl: true },
      },
    });

    const { provider, catalog, staticCatalog } = await captureProviderEntry({
      entry,
      config: {
        models: {
          providers: {
            demo: {
              baseUrl: "https://override.demo.test/v1",
              models: [createModel("configured", "Configured")],
            },
          },
        },
      },
    });

    expect(provider?.auth[0]?.starterModel).toBe("demo/custom");
    expect(catalog).toMatchObject({ provider: { baseUrl: "https://override.demo.test/v1" } });
    expect(staticCatalog).toMatchObject({ provider: { baseUrl: "https://api.demo.test/v1" } });
  });

  it("rejects manifest API-key metadata without its declared credential source", () => {
    const manifest = createProviderManifest();
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      manifest: { ...manifest, setup: { providers: [] } },
      provider: { label: "Demo", docsPath: "/providers/demo", catalog: {} },
    });

    expect(() => capturePluginRegistration(entry)).toThrow(
      'Incomplete manifest API-key auth for provider "demo"',
    );
  });

  it("rejects a provider catalog without a manifest catalog or explicit builder", () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      provider: { label: "Demo", docsPath: "/providers/demo", catalog: {} },
    });

    expect(() => capturePluginRegistration(entry)).toThrow("Missing modelCatalog.providers.demo");
  });

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
        preserveLiteralProviderPrefix: true,
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
    expect(provider?.preserveLiteralProviderPrefix).toBe(true);
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

  it("skips unreadable provider catalog entries while preserving healthy siblings", async () => {
    const providers = Object.defineProperty(
      {
        mockplugin: {
          api: "openai-completions" as const,
          baseUrl: "https://mockplugin.test/v1",
          models: [createModel("mock-model", "Mock Model")],
        },
      },
      "fuzzplugin",
      {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin provider catalog entry read failed");
        },
      },
    );
    const entry = defineSingleProviderPluginEntry({
      id: "mockplugin",
      name: "Mock Provider",
      description: "Synthetic provider plugin",
      provider: {
        label: "Mock",
        docsPath: "/providers/mockplugin",
        catalog: {
          run: async () => ({ providers }),
        },
      },
    });

    const { unifiedCatalog } = await captureProviderEntry({ entry });
    expect(unifiedCatalog).toEqual([
      {
        kind: "text",
        provider: "mockplugin",
        model: "mock-model",
        label: "Mock Model",
        source: "live",
      },
    ]);
  });

  it("skips unreadable provider catalog model rows while preserving healthy siblings", async () => {
    const models = Object.defineProperty([createModel("mock-model", "Mock Model")], "1", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin provider model row read failed");
      },
    });
    const entry = defineSingleProviderPluginEntry({
      id: "mockplugin",
      name: "Mock Provider",
      description: "Synthetic provider plugin",
      provider: {
        label: "Mock",
        docsPath: "/providers/mockplugin",
        catalog: {
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models,
              },
            },
          }),
        },
      },
    });

    const { unifiedCatalog } = await captureProviderEntry({ entry });
    expect(unifiedCatalog).toEqual([
      {
        kind: "text",
        provider: "mockplugin",
        model: "mock-model",
        label: "Mock Model",
        source: "live",
      },
    ]);
  });

  it("skips unreadable provider auth option rows while preserving healthy entries", async () => {
    const unreadableAuth = Object.defineProperty(
      {
        methodId: "fuzz-api-key",
        label: "Fuzz API key",
        optionKey: "fuzzApiKey",
        flagName: "--fuzz-api-key" as const,
        envVar: "FUZZ_API_KEY",
        promptMessage: "Enter Fuzz API key",
      },
      "label",
      {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin provider auth label read failed");
        },
      },
    );
    const entry = defineSingleProviderPluginEntry({
      id: "mockplugin",
      name: "Mock Provider",
      description: "Synthetic provider plugin",
      provider: {
        label: "Mock",
        docsPath: "/providers/mockplugin",
        auth: [
          unreadableAuth,
          {
            methodId: "mock-api-key",
            label: "Mock API key",
            optionKey: "mockApiKey",
            flagName: "--mock-api-key",
            envVar: "MOCK_API_KEY",
            promptMessage: "Enter Mock API key",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://mockplugin.test/v1",
            models: [],
          }),
        },
      },
    });

    const { provider } = await captureProviderEntry({ entry });
    expect(provider?.envVars).toEqual(["MOCK_API_KEY"]);
    expect(provider?.auth.map((method) => method.id)).toEqual(["mock-api-key"]);
  });

  it("registers extra non-api-key auth methods", async () => {
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
        extraAuth: [
          {
            id: "oauth",
            label: "Demo OAuth",
            hint: "OAuth",
            kind: "oauth",
            wizard: {
              choiceId: "demo-oauth",
              choiceLabel: "Demo OAuth",
              groupId: "demo",
              groupLabel: "Demo",
              methodId: "oauth",
            },
            run: async () => ({ profiles: [] }),
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.demo.test/v1",
            models: [createModel("default", "Default")],
          }),
        },
      },
    });

    const { provider } = await captureProviderEntry({ entry });
    expect(provider?.auth.map((method) => method.id)).toEqual(["api-key", "oauth"]);
    expect(provider?.auth[1]?.wizard?.choiceId).toBe("demo-oauth");
  });
});
