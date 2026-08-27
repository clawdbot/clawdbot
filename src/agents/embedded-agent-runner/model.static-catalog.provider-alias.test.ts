import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifestMocks.loadPluginManifestRegistryCore,
}));

import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolveManifestModelCatalogProviderAliasMetadata } from "./model.static-catalog.js";

const canonicalizeManifestModelCatalogProviderAlias = (
  params: Parameters<typeof resolveManifestModelCatalogProviderAliasMetadata>[0],
) => resolveManifestModelCatalogProviderAliasMetadata(params).provider;

function setConflictingAzureAliasPlugins() {
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["openai"],
        modelCatalog: {
          aliases: {
            "azure-openai-responses": {
              provider: "openai",
              api: "azure-openai-responses",
            },
          },
        },
      },
      {
        id: "workspace-override",
        origin: "workspace",
        providers: ["github-copilot"],
        modelCatalog: {
          aliases: {
            "azure-openai-responses": { provider: "github-copilot" },
          },
        },
      },
    ],
  });
}

function setConditionalSuppressionAliasPlugin(params?: { unconditional?: boolean }) {
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [
      {
        id: "conditional-provider",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["target-provider"],
        modelCatalog: {
          aliases: {
            "conditional-alias": {
              provider: "target-provider",
              api: "openai-responses",
            },
          },
          suppressions: [
            {
              provider: "conditional-alias",
              model: "conditional-model",
              ...(params?.unconditional
                ? {}
                : { when: { baseUrlHosts: ["matching.example.com"] } }),
            },
          ],
        },
      },
    ],
  });
}

function expectManifestAliasResolution(
  params: Parameters<typeof resolveManifestModelCatalogProviderAliasMetadata>[0],
  expected: ReturnType<typeof resolveManifestModelCatalogProviderAliasMetadata>,
) {
  expect(resolveManifestModelCatalogProviderAliasMetadata(params)).toEqual(expected);
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReset();
  manifestMocks.loadPluginManifestRegistryCore.mockReset();
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [] });
});

describe("canonicalizeManifestModelCatalogProviderAlias", () => {
  it("canonicalizes unambiguous manifest-owned aliases", () => {
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "moonshot",
          origin: "bundled",
          enabledByDefault: true,
          providers: ["moonshot"],
          modelCatalog: {
            aliases: {
              "moonshot-ai": { provider: "moonshot" },
              moonshotai: { provider: "moonshot" },
            },
          },
        },
      ],
    });

    for (const provider of ["moonshotai", "moonshot-ai"]) {
      expect(canonicalizeManifestModelCatalogProviderAlias({ provider })).toBe("moonshot");
    }
  });

  it("reuses the current plugin metadata snapshot for repeated alias lookups", () => {
    const plugins = [
      {
        id: "moonshot",
        origin: "bundled",
        enabledByDefault: true,
        providers: ["moonshot"],
        modelCatalog: {
          aliases: {
            "moonshot-ai": { provider: "moonshot" },
          },
        },
      },
    ];
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins });

    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai" })).toBe(
      "moonshot",
    );
    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai" })).toBe(
      "moonshot",
    );
    expect(manifestMocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenLastCalledWith({
      config: undefined,
      env: process.env,
      requireDefaultDiscoveryContext: true,
      workspaceDir: undefined,
    });
  });

  it("requests an exact configured workspace snapshot", () => {
    const cfg = { plugins: { allow: ["openai"] } };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });

    canonicalizeManifestModelCatalogProviderAlias({
      provider: "openai",
      cfg,
      workspaceDir: "/workspace",
    });

    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
      workspaceDir: "/workspace",
    });
  });

  it("keeps custom environments on their own manifest registry context", () => {
    const env = { HOME: "/custom-home" };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "moonshot",
          origin: "bundled",
          enabledByDefault: true,
          providers: ["moonshot"],
          modelCatalog: {
            aliases: {
              "moonshot-ai": { provider: "moonshot" },
            },
          },
        },
      ],
    });

    expect(canonicalizeManifestModelCatalogProviderAlias({ provider: "moonshot-ai", env })).toBe(
      "moonshot",
    );
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifestRegistryCore).toHaveBeenCalledWith({
      config: undefined,
      env,
      workspaceDir: undefined,
    });
  });

  it("canonicalizes endpoint-less aliases and retains complete transport metadata", () => {
    const plugin = {
      id: "openai",
      origin: "bundled",
      enabledByDefault: true,
      providers: ["openai"],
      modelCatalog: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
          },
        },
        aliases: {
          "azure-openai-responses": {
            provider: "openai",
            api: "azure-openai-responses",
          },
          "openai-fixed-endpoint": {
            provider: "openai",
            baseUrl: "https://manifest-alias.example.com/openai/v1",
          },
        },
        discovery: { openai: "runtime" },
      },
    };
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [plugin] });

    expectManifestAliasResolution(
      {
        provider: "azure-openai-responses",
      },
      { provider: "openai", transport: undefined },
    );
    expectManifestAliasResolution(
      {
        provider: "azure-openai-responses",
        modelId: "gpt-5.5",
        cfg: {
          models: {
            providers: {
              "azure-openai-responses": {
                baseUrl: "https://example.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
      },
      { provider: "azure-openai-responses", transport: { api: "azure-openai-responses" } },
    );
    expectManifestAliasResolution(
      {
        provider: "openai-fixed-endpoint",
        modelId: "gpt-5.5",
        cfg: {
          models: {
            providers: {
              "openai-fixed-endpoint": {
                api: "anthropic-messages",
                baseUrl: "https://configured-alias.example.com/v1",
                models: [],
              },
            },
          },
        },
      },
      {
        provider: "openai-fixed-endpoint",
        transport: {
          api: "anthropic-messages",
          baseUrl: "https://manifest-alias.example.com/openai/v1",
        },
      },
    );
  });

  it.each([
    ["matches", "https://matching.example.com/v1"],
    ["does not match", "https://other.example.com/v1"],
  ])(
    "does not use a conditional suppression to rewrite alias ownership when the endpoint %s",
    (_condition, baseUrl) => {
      setConditionalSuppressionAliasPlugin();
      const cfg = {
        models: {
          providers: {
            "conditional-alias": {
              baseUrl,
              api: "openai-responses" as const,
              models: [],
            },
          },
        },
      };

      expectManifestAliasResolution(
        {
          provider: "conditional-alias",
          modelId: "conditional-model",
          cfg,
        },
        { provider: "conditional-alias", transport: { api: "openai-responses" } },
      );
    },
  );

  it("lets an unconditional suppression canonicalize a transport alias", () => {
    setConditionalSuppressionAliasPlugin({ unconditional: true });
    const cfg = {
      models: {
        providers: {
          "conditional-alias": {
            baseUrl: "https://matching.example.com/v1",
            api: "openai-responses" as const,
            models: [],
          },
        },
      },
    };

    expectManifestAliasResolution(
      {
        provider: "conditional-alias",
        modelId: "conditional-model",
        cfg,
      },
      { provider: "target-provider", transport: undefined },
    );
  });

  it("ignores inactive workspace claims that collide with a bundled transport alias", () => {
    setConflictingAzureAliasPlugins();
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            models: [],
          },
        },
      },
    };

    expectManifestAliasResolution(
      {
        provider: "azure-openai-responses",
        modelId: "gpt-5.4-mini",
        cfg,
      },
      { provider: "azure-openai-responses", transport: { api: "azure-openai-responses" } },
    );
  });

  it("accepts activated config-load-path alias owners", () => {
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "config-provider",
          origin: "config",
          providers: ["custom-openai"],
          modelCatalog: {
            aliases: {
              "custom-openai-alias": {
                provider: "custom-openai",
                api: "openai-responses",
                baseUrl: "https://config-provider.example.com/v1",
              },
            },
          },
        },
      ],
    });

    expectManifestAliasResolution(
      {
        provider: "custom-openai-alias",
        modelId: "custom-model",
      },
      {
        provider: "custom-openai-alias",
        transport: {
          api: "openai-responses",
          baseUrl: "https://config-provider.example.com/v1",
        },
      },
    );
  });

  it("fails closed when activated plugins claim the same provider alias", () => {
    setConflictingAzureAliasPlugins();
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            models: [],
          },
        },
      },
      plugins: {
        entries: {
          "workspace-override": { enabled: true },
        },
      },
    };

    expectManifestAliasResolution(
      {
        provider: "azure-openai-responses",
        modelId: "gpt-5.3-codex-spark",
        cfg,
      },
      { provider: "azure-openai-responses", transport: undefined, ambiguous: true },
    );
  });
});
