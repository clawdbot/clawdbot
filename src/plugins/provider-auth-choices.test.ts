import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  loadPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

vi.resetModules();

const {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderApiKeyChoice,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveManifestProviderOnboardAuthFlags,
} = await import("./provider-auth-choices.js");
const { resetProviderAuthAliasMapCacheForTest, resolveProviderIdForAuth } =
  await import("../agents/provider-auth-aliases.js");

function createManifestPlugin(id: string, providerAuthChoices: Array<Record<string, unknown>>) {
  return {
    id,
    providerAuthChoices,
  };
}

function createProviderAuthChoice(overrides: Record<string, unknown>) {
  return overrides;
}

function setManifestPlugins(plugins: Array<Record<string, unknown>>) {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
    plugins,
  });
  pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
    plugins,
  });
  pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue({
    plugins,
    manifestRegistry: { plugins },
  });
}

function expectResolvedProviderAuthChoices(params: {
  expectedFlattened: Array<Record<string, unknown>>;
  resolvedProviderIds?: Record<string, string | undefined>;
  deprecatedChoiceIds?: Record<string, string | undefined>;
}) {
  expect(resolveManifestProviderAuthChoices()).toEqual(params.expectedFlattened);
  Object.entries(params.resolvedProviderIds ?? {}).forEach(([choiceId, providerId]) => {
    expect(resolveManifestProviderAuthChoice(choiceId)?.providerId).toBe(providerId);
  });
  Object.entries(params.deprecatedChoiceIds ?? {}).forEach(([choiceId, expectedChoiceId]) => {
    expect(resolveManifestDeprecatedProviderAuthChoice(choiceId)?.choiceId).toBe(expectedChoiceId);
  });
}

function setSingleManifestProviderAuthChoices(
  pluginId: string,
  providerAuthChoices: Array<Record<string, unknown>>,
) {
  setManifestPlugins([createManifestPlugin(pluginId, providerAuthChoices)]);
}

describe("provider auth choice manifest helpers", () => {
  beforeEach(() => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      manifestRegistry: { plugins: [] },
    });
    resetProviderAuthAliasMapCacheForTest();
  });

  it("flattens manifest auth choices", () => {
    setSingleManifestProviderAuthChoices("openai", [
      createProviderAuthChoice({
        provider: "openai",
        method: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        assistantPriority: 10,
        assistantVisibility: "visible",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      }),
    ]);

    expectResolvedProviderAuthChoices({
      expectedFlattened: [
        {
          pluginId: "openai",
          providerId: "openai",
          methodId: "api-key",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          assistantPriority: 10,
          assistantVisibility: "visible",
          onboardingScopes: ["text-inference"],
          optionKey: "openaiApiKey",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
        },
      ],
      resolvedProviderIds: { "openai-api-key": "openai" },
    });
  });

  it.each([
    {
      name: "deduplicates flag metadata by option key + flag",
      plugins: [
        createManifestPlugin("moonshot", [
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key",
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key-cn",
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
        ]),
      ],
      run: () =>
        expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
          {
            optionKey: "moonshotApiKey",
            authChoice: "moonshot-api-key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            description: "Moonshot API key",
          },
        ]),
    },
    {
      name: "resolves deprecated auth-choice aliases through manifest metadata",
      plugins: [
        createManifestPlugin("minimax", [
          createProviderAuthChoice({
            provider: "minimax",
            method: "api-global",
            choiceId: "minimax-global-api",
            deprecatedChoiceIds: ["minimax", "minimax-api"],
          }),
        ]),
      ],
      run: () =>
        expectResolvedProviderAuthChoices({
          expectedFlattened: [
            {
              pluginId: "minimax",
              providerId: "minimax",
              methodId: "api-global",
              choiceId: "minimax-global-api",
              choiceLabel: "minimax-global-api",
              deprecatedChoiceIds: ["minimax", "minimax-api"],
            },
          ],
          deprecatedChoiceIds: {
            minimax: "minimax-global-api",
            "minimax-api": "minimax-global-api",
            openai: undefined,
          },
        }),
    },
  ])("$name", ({ plugins, run }) => {
    setManifestPlugins(plugins);
    run();
  });

  it("can exclude untrusted workspace plugin auth choices during onboarding resolution", () => {
    setManifestPlugins([
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerAuthChoices: [
          {
            provider: "openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
      {
        id: "evil-openai-hijack",
        origin: "workspace",
        providers: ["evil-openai"],
        providerAuthChoices: [
          {
            provider: "evil-openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
    ]);

    expect(
      resolveManifestProviderAuthChoices({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      expect.objectContaining({
        pluginId: "openai",
        providerId: "openai",
        choiceId: "openai-api-key",
      }),
    ]);
    expect(
      resolveManifestProviderAuthChoice("openai-api-key", {
        includeUntrustedWorkspacePlugins: false,
      })?.providerId,
    ).toBe("openai");
    expect(
      resolveManifestProviderOnboardAuthFlags({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);
  });

  it("derives generic auth choices from descriptor-safe setup provider auth methods", () => {
    setManifestPlugins([
      {
        id: "demo-provider",
        name: "Demo Provider",
        origin: "global",
        setup: {
          providers: [
            {
              id: "demo-provider",
              authMethods: ["api-key", "oauth"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
        groupId: "demo-provider",
        groupLabel: "Demo Provider",
      },
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "oauth",
        choiceId: "demo-provider-oauth",
        choiceLabel: "Demo Provider OAuth",
        groupId: "demo-provider",
        groupLabel: "Demo Provider",
      },
    ]);
  });

  it("sanitizes setup provider auth descriptors before deriving prompt labels", () => {
    setManifestPlugins([
      {
        id: "evil-provider",
        origin: "workspace",
        setup: {
          providers: [
            {
              id: "evil\u001b[31m-provider",
              authMethods: ["jwt\u001b[2K", "oidc"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: "evil-provider",
        providerId: "evil-provider",
        methodId: "jwt",
        choiceId: "evil-provider-jwt",
        choiceLabel: "Evil Provider JWT",
        groupId: "evil-provider",
        groupLabel: "Evil Provider",
      },
      {
        pluginId: "evil-provider",
        providerId: "evil-provider",
        methodId: "oidc",
        choiceId: "evil-provider-oidc",
        choiceLabel: "Evil Provider OIDC",
        groupId: "evil-provider",
        groupLabel: "Evil Provider",
      },
    ]);
  });

  it("uses setup provider auth methods when no setup entry exists", () => {
    setManifestPlugins([
      {
        id: "no-runtime-provider",
        origin: "global",
        setup: {
          providers: [
            {
              id: "no-runtime-provider",
              authMethods: ["api-key"],
            },
          ],
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoice("no-runtime-provider-api-key")).toEqual({
      pluginId: "no-runtime-provider",
      providerId: "no-runtime-provider",
      methodId: "api-key",
      choiceId: "no-runtime-provider-api-key",
      choiceLabel: "No Runtime Provider API key",
      groupId: "no-runtime-provider",
      groupLabel: "No Runtime Provider",
    });
  });

  it("keeps setup-entry providers on explicit manifest or runtime auth choices", () => {
    setManifestPlugins([
      {
        id: "runtime-provider",
        origin: "global",
        setupSource: "/plugins/runtime-provider/setup-entry.cjs",
        setup: {
          providers: [
            {
              id: "runtime-provider",
              authMethods: ["api-key"],
            },
          ],
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([]);
  });

  it("does not duplicate explicit provider auth choices with setup auth methods", () => {
    setManifestPlugins([
      {
        id: "explicit-provider",
        origin: "global",
        providerAuthChoices: [
          {
            provider: "explicit-provider",
            method: "api-key",
            choiceId: "explicit-api-key",
            choiceLabel: "Explicit API key",
          },
        ],
        setup: {
          providers: [
            {
              id: "explicit-provider",
              authMethods: ["api-key", "oauth"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: "explicit-provider",
        providerId: "explicit-provider",
        methodId: "api-key",
        choiceId: "explicit-api-key",
        choiceLabel: "Explicit API key",
      },
      {
        pluginId: "explicit-provider",
        providerId: "explicit-provider",
        methodId: "oauth",
        choiceId: "explicit-provider-oauth",
        choiceLabel: "Explicit Provider OAuth",
        groupId: "explicit-provider",
        groupLabel: "Explicit Provider",
      },
    ]);
  });

  it("prefers bundled auth-choice handlers when choice IDs collide across origins", () => {
    setManifestPlugins([
      {
        id: "evil-openai-hijack",
        origin: "workspace",
        providers: ["evil-openai"],
        providerAuthChoices: [
          {
            provider: "evil-openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerAuthChoices: [
          {
            provider: "openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      expect.objectContaining({
        pluginId: "openai",
        providerId: "openai",
        choiceId: "openai-api-key",
      }),
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("openai");
    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);
  });

  it("prefers trusted config auth-choice handlers over bundled collisions", () => {
    setManifestPlugins([
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerAuthChoices: [
          {
            provider: "openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
      {
        id: "custom-openai",
        origin: "config",
        providers: ["custom-openai"],
        providerAuthChoices: [
          {
            provider: "custom-openai",
            method: "api-key",
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
          },
        ],
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      expect.objectContaining({
        pluginId: "custom-openai",
        providerId: "custom-openai",
        choiceId: "openai-api-key",
      }),
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("custom-openai");
    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);
  });

  it("resolves api-key choices through manifest-owned provider auth aliases", () => {
    setManifestPlugins([
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
        providerAuthChoices: [
          {
            provider: "fixture-provider",
            method: "api-key",
            choiceId: "fixture-provider-api-key",
            choiceLabel: "Fixture Provider API key",
            optionKey: "fixtureProviderApiKey",
            cliFlag: "--fixture-provider-api-key",
            cliOption: "--fixture-provider-api-key <key>",
          },
        ],
      },
    ]);

    const resolvedProviderId = resolveProviderIdForAuth("fixture-provider-plan");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
    expect(resolvedProviderId).toBe("fixture-provider");
    expect(
      resolveManifestProviderApiKeyChoice({
        providerId: "fixture-provider-plan",
      })?.choiceId,
    ).toBe("fixture-provider-api-key");
  });
});
