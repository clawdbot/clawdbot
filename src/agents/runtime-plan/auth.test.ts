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

import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";

describe("buildAgentRuntimeAuthPlan", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
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

  it.each(["api_key", "oauth", "token"])(
    "keeps an OpenAI-aliased custom route provider-owned for %s auth",
    (mode) => {
      pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
        plugins: [
          {
            id: "alias-owner",
            origin: "global",
            providerAuthAliases: { "custom-provider": "openai" },
          },
        ],
        diagnostics: [],
      });
      const plan = buildAgentRuntimeAuthPlan({
        provider: "custom-provider",
        authProfileProvider: "openai",
        authProfileMode: mode,
        sessionAuthProfileId: "openai:work",
        harnessId: "codex",
        harnessRequiresHostApiKey: true,
      });
      expect(plan.providerForAuth).toBe("openai");
      expect(plan.harnessAuthProvider).toBeUndefined();
      expect(plan.requiresHostApiKey).toBe(true);
      expect(plan.forwardedAuthProfileId).toBe(mode === "api_key" ? "openai:work" : undefined);
    },
  );

  it.each([
    { source: "direct", mode: "api-key", profileId: undefined },
    { source: "profile", mode: "api_key", profileId: "custom-provider:work" },
  ])("preserves provider-owned $source API-key auth for Codex", ({ mode, profileId }) => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "custom-provider",
      authProfileProvider: "custom-provider",
      authProfileMode: mode,
      sessionAuthProfileId: profileId,
      sessionAuthProfileSource: "user",
      sessionAuthProfileCandidateIds: profileId ? [profileId] : undefined,
      harnessId: "codex",
      harnessRequiresHostApiKey: true,
      metadataSnapshot: { plugins: [] },
    });

    expect(plan.harnessAuthProvider).toBeUndefined();
    expect(plan.selectedAuthMode).toBe(mode);
    expect(plan.forwardedAuthProfileId).toBe(profileId);
    expect(plan.forwardedAuthProfileSource).toBe(profileId ? "user" : undefined);
    expect(plan.forwardedAuthProfileCandidateIds).toEqual(profileId ? [profileId] : undefined);
    expect(plan.modelRoute).toBeUndefined();
  });

  it.each([
    { name: "another provider's key", owner: "another-provider", mode: "api_key", allow: true },
    { name: "an OpenAI key", owner: "openai", mode: "api_key", allow: true },
    { name: "OAuth", owner: "custom-provider", mode: "oauth", allow: true },
    { name: "a token", owner: "custom-provider", mode: "token", allow: true },
    { name: "a subscription", owner: "custom-provider", mode: "subscription", allow: true },
    { name: "an unselected credential", owner: "custom-provider", mode: undefined, allow: true },
    { name: "disabled forwarding", owner: "custom-provider", mode: "api-key", allow: false },
  ])("does not forward $name as custom Codex auth", ({ owner, mode, allow }) => {
    const plan = buildAgentRuntimeAuthPlan({
      provider: "custom-provider",
      authProfileProvider: owner,
      authProfileMode: mode,
      sessionAuthProfileId: `${owner}:work`,
      sessionAuthProfileSource: "user",
      sessionAuthProfileCandidateIds: [`${owner}:work`],
      harnessRuntime: "codex",
      harnessRequiresHostApiKey: true,
      allowHarnessAuthProfileForwarding: allow,
      metadataSnapshot: { plugins: [] },
    });

    expect(plan.harnessAuthProvider).toBeUndefined();
    expect(plan.forwardedAuthProfileId).toBeUndefined();
    expect(plan.forwardedAuthProfileSource).toBeUndefined();
    expect(plan.forwardedAuthProfileCandidateIds).toBeUndefined();
    expect(plan.selectedAuthMode).toBeUndefined();
  });

  it.each([
    { provider: "codex", mode: "oauth" },
    { provider: "openai", mode: "api_key" },
  ])("retains native OpenAI auth ownership for $provider", ({ provider, mode }) => {
    const plan = buildAgentRuntimeAuthPlan({
      provider,
      authProfileProvider: "openai",
      authProfileMode: mode,
      sessionAuthProfileId: "openai:work",
      harnessRuntime: "codex",
      metadataSnapshot: { plugins: [] },
    });

    expect(plan).toMatchObject({
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:work",
      selectedAuthMode: mode,
    });
  });
});
