// Runtime plan auth tests cover provider/auth-profile selection and plugin
// alias loading behavior for the auth portion of the plan.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    loadPluginMetadataSnapshot: vi.fn((params: unknown) => {
      const registry = loadManifestRegistry(params) ?? { plugins: [], diagnostics: [] };
      return {
        index: {
          plugins: registry.plugins.map((plugin: { id: string; origin?: string }) => ({
            pluginId: plugin.id,
            origin: plugin.origin ?? "global",
            enabled: true,
            enabledByDefault: true,
          })),
        },
        plugins: registry.plugins,
      };
    }),
  };
});

vi.mock("../../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

import { resetProviderAuthAliasMapCacheForTest } from "../provider-auth-aliases.test-support.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";

describe("buildAgentRuntimeAuthPlan", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("does not load provider auth aliases when plugins are disabled", () => {
    // Disabling alias support should avoid metadata loading entirely, not just
    // ignore aliases after doing plugin work.
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "alias-owner",
          origin: "global",
          providerAuthAliases: { fixture: "provider-two" },
        },
      ],
      diagnostics: [],
    });

    const plan = buildAgentRuntimeAuthPlan({
      provider: "fixture",
      authProfileProvider: "fixture",
      config: {},
      providerAuthAliasesEnabled: false,
    });

    expect(plan.providerForAuth).toBe("fixture");
    expect(plan.authProfileProviderForAuth).toBe("fixture");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("derives disabled provider auth aliases from plugin config", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "alias-owner",
          origin: "global",
          providerAuthAliases: { fixture: "provider-two" },
        },
      ],
      diagnostics: [],
    });

    const plan = buildAgentRuntimeAuthPlan({
      provider: "fixture",
      authProfileProvider: "fixture",
      config: { plugins: { enabled: false } },
    });

    expect(plan.providerForAuth).toBe("fixture");
    expect(plan.authProfileProviderForAuth).toBe("fixture");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("preserves the selected model route and locked profile source", () => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "openai",
      authProfileProvider: "openai",
      authProfileMode: "token",
      sessionAuthProfileId: "openai:work",
      sessionAuthProfileSource: "user",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authRequirement: "subscription",
        requestTransportOverrides: "none",
      },
      config: {},
    });

    expect(plan).toMatchObject({
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
      selectedAuthMode: "token",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        authRequirement: "subscription",
      },
    });
  });

  it("does not forward profiles when the harness rejects host auth", () => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "openai",
      authProfileProvider: "openai",
      authProfileMode: "api_key",
      sessionAuthProfileId: "openai:work",
      sessionAuthProfileSource: "auto",
      sessionAuthProfileCandidateIds: ["openai:work"],
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
      config: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      allowHarnessAuthProfileForwarding: false,
    });

    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBeUndefined();
  });
});
