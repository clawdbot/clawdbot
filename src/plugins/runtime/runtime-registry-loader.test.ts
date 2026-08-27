// Runtime registry loader tests cover the surviving process-root load scopes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveEffectivePluginIds:
    vi.fn<typeof import("../effective-plugin-ids.js").resolveEffectivePluginIds>(),
  collectConfiguredMemoryEmbeddingProviderIds:
    vi.fn<
      typeof import("../gateway-startup-plugin-ids.js").collectConfiguredMemoryEmbeddingProviderIds
    >(),
  applyPluginAutoEnable:
    vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  resolvePluginMetadataSnapshot:
    vi.fn<typeof import("../plugin-metadata-snapshot.js").resolvePluginMetadataSnapshot>(),
  isPluginMetadataSnapshotCompatible:
    vi.fn<typeof import("../plugin-metadata-snapshot.js").isPluginMetadataSnapshotCompatible>(),
  rebasePluginMetadataSnapshotManifestRegistry: vi.fn<
    typeof import("../plugin-metadata-snapshot.js").rebasePluginMetadataSnapshotManifestRegistry
  >((snapshot) => snapshot),
  listAgentEntries: vi.fn<typeof import("../../agents/agent-scope.js").listAgentEntries>(() => []),
  resolveAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").tryResolveConfiguredAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  resolvePluginControlPlaneWorkspace: vi.fn<
    typeof import("../control-plane-workspace.js").resolvePluginControlPlaneWorkspace
  >((params) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected",
  })),
  resolveDefaultAgentId: vi.fn<typeof import("../../agents/agent-scope.js").resolveDefaultAgentId>(
    () => "default",
  ),
}));

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
}));

vi.mock("../effective-plugin-ids.js", () => ({
  resolveEffectivePluginIds: (...args: Parameters<typeof mocks.resolveEffectivePluginIds>) =>
    mocks.resolveEffectivePluginIds(...args),
}));

vi.mock("../gateway-startup-plugin-ids.js", () => ({
  collectConfiguredMemoryEmbeddingProviderIds: (
    ...args: Parameters<typeof mocks.collectConfiguredMemoryEmbeddingProviderIds>
  ) => mocks.collectConfiguredMemoryEmbeddingProviderIds(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: (
    ...args: Parameters<typeof mocks.resolvePluginMetadataSnapshot>
  ) => mocks.resolvePluginMetadataSnapshot(...args),
  isPluginMetadataSnapshotCompatible: (
    ...args: Parameters<typeof mocks.isPluginMetadataSnapshotCompatible>
  ) => mocks.isPluginMetadataSnapshotCompatible(...args),
  rebasePluginMetadataSnapshotManifestRegistry: (
    ...args: Parameters<typeof mocks.rebasePluginMetadataSnapshotManifestRegistry>
  ) => mocks.rebasePluginMetadataSnapshotManifestRegistry(...args),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: (...args: Parameters<typeof mocks.listAgentEntries>) =>
    mocks.listAgentEntries(...args),
  resolveAgentWorkspaceDir: (...args: Parameters<typeof mocks.resolveAgentWorkspaceDir>) =>
    mocks.resolveAgentWorkspaceDir(...args),
  tryResolveConfiguredAgentWorkspaceDir: (
    ...args: Parameters<typeof mocks.tryResolveConfiguredAgentWorkspaceDir>
  ) => mocks.tryResolveConfiguredAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: Parameters<typeof mocks.resolveDefaultAgentId>) =>
    mocks.resolveDefaultAgentId(...args),
}));

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: (
    ...args: Parameters<typeof mocks.resolvePluginControlPlaneWorkspace>
  ) => mocks.resolvePluginControlPlaneWorkspace(...args),
}));

import { ensurePluginRegistryLoaded } from "./runtime-registry-loader.js";

function useMemoryProviderOwner(params: {
  adapterId: string;
  contract: "embeddingProviders";
  pluginId: string;
}): void {
  mocks.resolvePluginMetadataSnapshot.mockReturnValue({
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: [
        {
          pluginId: params.pluginId,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          contributions: {
            contracts: { [params.contract]: [params.adapterId] },
          },
        },
      ],
    },
    manifestRegistry: { plugins: [], diagnostics: [] },
  } as never);
}

function requireLoadOptions(): Record<string, unknown> {
  const options = mocks.loadOpenClawPlugins.mock.calls[0]?.[0];
  if (!options) {
    throw new Error("expected plugin load options");
  }
  return options as Record<string, unknown>;
}

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePluginMetadataSnapshot.mockReset().mockReturnValue({
      index: {
        installRecords: {},
        plugins: [
          {
            pluginId: "openai",
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
          },
        ],
      },
      manifestRegistry: { plugins: [], diagnostics: [] },
    } as never);
    mocks.isPluginMetadataSnapshotCompatible.mockReturnValue(true);
    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
  });

  it("loads configured channel owners through the canonical root loader", () => {
    const config = { channels: { demo: { enabled: true } } };
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels", config: config as never });

    expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ config, workspaceDir: "/resolved-workspace" }),
    );
    expect(requireLoadOptions()).toEqual(
      expect.objectContaining({
        onlyPluginIds: ["demo-channel"],
        throwOnLoadError: true,
        workspaceDir: "/resolved-workspace",
      }),
    );
  });

  it("keeps an empty configured-channel scope empty", () => {
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({ scope: "configured-channels", config: {} });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });

  it("loads effective plugin ids for the all scope", () => {
    const config = { plugins: { enabled: true } };
    mocks.resolveEffectivePluginIds.mockReturnValue(["demo", "memory-core"]);

    ensurePluginRegistryLoaded({ scope: "all", config });

    expect(mocks.resolveEffectivePluginIds).toHaveBeenCalledWith({
      config,
      env: process.env,
      workspaceDir: "/resolved-workspace",
    });
    expect(requireLoadOptions()).toEqual(
      expect.objectContaining({
        onlyPluginIds: ["demo", "memory-core"],
        throwOnLoadError: true,
      }),
    );
  });

  it("loads only matching configured sandbox backend owners, never unrelated broken plugins", () => {
    const config = {
      agents: {
        defaults: { sandbox: { backend: "sandbox-owner" } },
        entries: { research: { sandbox: { backend: "research-owner" } } },
      },
      plugins: {
        entries: {
          "sandbox-owner": { enabled: true },
          "research-owner": { enabled: true },
          "broken-plugin": { enabled: true },
        },
      },
    };
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      index: {
        installRecords: {},
        plugins: ["sandbox-owner", "research-owner", "broken-plugin"].map((pluginId) => ({
          pluginId,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
        })),
      },
      manifestRegistry: { plugins: [], diagnostics: [] },
    } as never);
    mocks.loadOpenClawPlugins.mockImplementationOnce((options) => {
      if (options?.onlyPluginIds?.includes("broken-plugin")) {
        throw new Error("unrelated plugin failed to initialize");
      }
      return undefined as never;
    });

    expect(() => ensurePluginRegistryLoaded({ scope: "sandbox-backends", config })).not.toThrow();
    expect(requireLoadOptions().onlyPluginIds).toEqual(["research-owner", "sandbox-owner"]);
    expect(mocks.resolveEffectivePluginIds).not.toHaveBeenCalled();
  });

  it.each([undefined, "docker", "podman", "ssh"])(
    "does not activate plugins for the built-in sandbox backend %s",
    (backend) => {
      mocks.resolvePluginMetadataSnapshot.mockReturnValue({
        index: {
          installRecords: {},
          plugins: ["docker", "podman", "ssh"].map((pluginId) => ({
            pluginId,
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
          })),
        },
        manifestRegistry: { plugins: [], diagnostics: [] },
      } as never);

      ensurePluginRegistryLoaded({
        scope: "sandbox-backends",
        config: { agents: { defaults: { sandbox: { backend } } } },
      });

      expect(requireLoadOptions().onlyPluginIds).toEqual([]);
      expect(mocks.resolveEffectivePluginIds).not.toHaveBeenCalled();
    },
  );

  it("does not guess a differently named sandbox backend owner", () => {
    mocks.resolvePluginMetadataSnapshot.mockReturnValue({
      index: {
        installRecords: {},
        plugins: [
          {
            pluginId: "actual-owner",
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
          },
        ],
      },
      manifestRegistry: { plugins: [], diagnostics: [] },
    } as never);

    ensurePluginRegistryLoaded({
      scope: "sandbox-backends",
      config: {
        agents: { defaults: { sandbox: { backend: "different-backend" } } },
        plugins: { entries: { "actual-owner": { enabled: true } } },
      },
    });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });

  it("loads only the selected memory backend and embedding provider owners", () => {
    const config = {
      memory: { search: { provider: "openai" } },
      plugins: {
        allow: ["acpx", "memory-core"],
        slots: { memory: "memory-core" },
        entries: { unrelated: { enabled: true } },
      },
    };
    mocks.collectConfiguredMemoryEmbeddingProviderIds.mockReturnValue(new Set(["openai"]));

    ensurePluginRegistryLoaded({ scope: "memory", config });

    expect(mocks.collectConfiguredMemoryEmbeddingProviderIds).toHaveBeenCalledWith(config);
    expect(requireLoadOptions()).toEqual(
      expect.objectContaining({
        config,
        activationSourceConfig: config,
        onlyPluginIds: ["memory-core", "openai"],
        throwOnLoadError: true,
      }),
    );
  });

  it.each([
    {
      adapterId: "gemini",
      contract: "embeddingProviders" as const,
      pluginId: "google",
    },
    {
      adapterId: "local",
      contract: "embeddingProviders" as const,
      pluginId: "llama-cpp",
    },
  ])("loads the $pluginId owner for the $adapterId memory adapter", (provider) => {
    const config = {
      memory: { search: { provider: provider.adapterId } },
      plugins: { slots: { memory: "memory-core" } },
    };
    mocks.collectConfiguredMemoryEmbeddingProviderIds.mockReturnValue(
      new Set([provider.adapterId]),
    );
    useMemoryProviderOwner(provider);

    ensurePluginRegistryLoaded({ scope: "memory", config });

    expect(requireLoadOptions().onlyPluginIds).toEqual(
      [provider.pluginId, "memory-core"].toSorted(),
    );
  });

  it("keeps a denied memory provider owner denied", () => {
    const config = {
      memory: { search: { provider: "gemini" } },
      plugins: {
        allow: ["memory-core"],
        deny: ["google"],
        slots: { memory: "memory-core" },
      },
    };
    mocks.collectConfiguredMemoryEmbeddingProviderIds.mockReturnValue(new Set(["gemini"]));
    useMemoryProviderOwner({
      adapterId: "gemini",
      contract: "embeddingProviders",
      pluginId: "google",
    });

    ensurePluginRegistryLoaded({ scope: "memory", config });

    const options = requireLoadOptions();
    expect(options.onlyPluginIds).toEqual(["google", "memory-core"]);
    expect(options.config).toEqual(config);
    expect(options.activationSourceConfig).toEqual(config);
  });

  it("keeps an explicitly disabled memory provider owner disabled", () => {
    const config = {
      memory: { search: { provider: "local" } },
      plugins: {
        entries: { "llama-cpp": { enabled: false } },
        slots: { memory: "memory-core" },
      },
    };
    mocks.collectConfiguredMemoryEmbeddingProviderIds.mockReturnValue(new Set(["local"]));
    useMemoryProviderOwner({
      adapterId: "local",
      contract: "embeddingProviders",
      pluginId: "llama-cpp",
    });

    ensurePluginRegistryLoaded({ scope: "memory", config });

    const options = requireLoadOptions();
    expect(options.onlyPluginIds).toEqual(["llama-cpp", "memory-core"]);
    expect(options.config).toEqual(config);
    expect(options.activationSourceConfig).toEqual(config);
  });

  it("keeps an empty memory scope empty when no backend is selected", () => {
    mocks.collectConfiguredMemoryEmbeddingProviderIds.mockReturnValue(new Set());

    ensurePluginRegistryLoaded({
      scope: "memory",
      config: { plugins: { slots: { memory: "none" } } },
    });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });
});
