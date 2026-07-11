// Verifies env API-key lookup through plugin provider-auth aliases.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveEnvApiKey,
  resolveProviderDirectAuthPlanningEvidence,
  resolveProviderEnvAuthEvidence,
} from "./model-auth-env.js";

const pluginMetadataMocks = vi.hoisted(() => {
  const snapshot = {
    index: {
      plugins: [
        {
          pluginId: "external-cloud",
          origin: "global",
          enabled: true,
          enabledByDefault: true,
        },
      ],
    },
    plugins: [
      {
        id: "external-cloud",
        origin: "global",
        providerAuthAliases: {
          "cloud-alias": "external-cloud",
        },
        providerAuthEnvVars: {
          "external-cloud": ["EXTERNAL_CLOUD_API_KEY"],
        },
      },
    ],
  };
  return {
    snapshot,
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

const setupRegistryMocks = vi.hoisted(() => ({
  resolvePluginSetupProvider: vi.fn(() => undefined),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider: setupRegistryMocks.resolvePluginSetupProvider,
}));

describe("resolveEnvApiKey provider auth aliases", () => {
  beforeEach(() => {
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockReset();
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(
      pluginMetadataMocks.snapshot,
    );
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReset();
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReturnValue(pluginMetadataMocks.snapshot);
    setupRegistryMocks.resolvePluginSetupProvider.mockReset();
    setupRegistryMocks.resolvePluginSetupProvider.mockReturnValue(undefined);
  });

  it("reuses the current scoped metadata snapshot while resolving provider auth aliases", () => {
    // The active scoped snapshot already reflects workspace/plugin filtering;
    // reloading metadata here can accidentally see a broader plugin set.
    expect(
      resolveEnvApiKey(
        "cloud-alias",
        {
          EXTERNAL_CLOUD_API_KEY: "secret",
        } as NodeJS.ProcessEnv,
        {
          config: {},
          workspaceDir: "/workspace",
        },
      ),
    ).toEqual({
      apiKey: "secret",
      source: "env: EXTERNAL_CLOUD_API_KEY",
    });
    expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: {
        EXTERNAL_CLOUD_API_KEY: "secret",
      },
      workspaceDir: "/workspace",
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("passes config and workspace scope to setup-provider fallback", () => {
    // Setup providers can derive env/config keys from workspace context, so the
    // fallback must receive the same scope as metadata resolution.
    const config = {};
    const env = {} as NodeJS.ProcessEnv;
    setupRegistryMocks.resolvePluginSetupProvider.mockReturnValue({
      resolveConfigApiKey: () => "setup-secret",
    } as never);

    expect(
      resolveEnvApiKey("setup-cloud", env, {
        config,
        workspaceDir: "/workspace",
      }),
    ).toEqual({
      apiKey: "setup-secret",
      source: "env",
    });
    expect(setupRegistryMocks.resolvePluginSetupProvider).toHaveBeenCalledWith({
      provider: "setup-cloud",
      config,
      workspaceDir: "/workspace",
      env,
    });
  });

  it("reports injected env evidence without returning material or loading provider setup", () => {
    expect(
      resolveProviderEnvAuthEvidence(
        "cloud-alias",
        { EXTERNAL_CLOUD_API_KEY: "secret" } as NodeJS.ProcessEnv,
        {
          aliasMap: { "cloud-alias": "external-cloud" },
          candidateMap: { "external-cloud": ["EXTERNAL_CLOUD_API_KEY"] },
          authEvidenceMap: {},
        },
      ),
    ).toEqual({ mode: "api-key", source: "env: EXTERNAL_CLOUD_API_KEY" });
    expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(setupRegistryMocks.resolvePluginSetupProvider).not.toHaveBeenCalled();
  });

  it("retains setup-provider fallback as deferred planning evidence without loading it", () => {
    expect(
      resolveProviderDirectAuthPlanningEvidence("cloud-alias", {} as NodeJS.ProcessEnv, {
        aliasMap: { "cloud-alias": "external-cloud" },
        candidateMap: { "external-cloud": ["EXTERNAL_CLOUD_API_KEY"] },
        authEvidenceMap: {},
        setupProviderFallbackRefs: ["external-cloud"],
      }),
    ).toEqual({ kind: "setup-provider", mode: "api-key", source: "setup provider" });
    expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(setupRegistryMocks.resolvePluginSetupProvider).not.toHaveBeenCalled();
  });
});
