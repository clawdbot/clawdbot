// Runtime registry loader tests cover the surviving process-root load scopes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { InstalledPluginIndexRecord } from "../installed-plugin-index-types.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";

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
  resolvePluginRuntimeLoadContext:
    vi.fn<typeof import("./load-context.resolve.js").resolvePluginRuntimeLoadContext>(),
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

vi.mock("./load-context.resolve.js", () => ({
  resolvePluginRuntimeLoadContext: mocks.resolvePluginRuntimeLoadContext,
}));

import { ensurePluginRegistryLoaded } from "./runtime-registry-loader.js";

let installedPlugins: InstalledPluginIndexRecord[];

function createInstalledPlugin(
  pluginId: string,
  contracts?: Record<string, readonly string[]>,
): InstalledPluginIndexRecord {
  return {
    pluginId,
    manifestPath: `/fake/${pluginId}/openclaw.plugin.json`,
    manifestHash: "test",
    rootDir: `/fake/${pluginId}`,
    origin: "config",
    enabled: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
    contributions: contracts
      ? {
          channels: [],
          channelConfigs: [],
          providers: [],
          modelCatalogProviders: [],
          modelSupportPrefixes: [],
          modelSupportPatterns: [],
          autoEnableProviderIds: [],
          commandAliases: [],
          contracts,
        }
      : undefined,
  };
}

function useMemoryProviderOwner(params: {
  adapterId: string;
  contract: "embeddingProviders";
  pluginId: string;
}): void {
  installedPlugins = [
    createInstalledPlugin(params.pluginId, { [params.contract]: [params.adapterId] }),
  ];
}

function requireLoadOptions() {
  const options = mocks.loadOpenClawPlugins.mock.calls[0]?.[0];
  if (!options) {
    throw new Error("expected plugin load options");
  }
  return options;
}

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installedPlugins = [createInstalledPlugin("openai")];
    mocks.resolvePluginRuntimeLoadContext.mockImplementation((options) => {
      const config = options?.config ?? {};
      const workspaceDir = options?.workspaceDir ?? "/resolved-workspace";
      const metadataSnapshot = createPluginMetadataSnapshot({
        config,
        workspaceDir,
        manifestRegistry: makeRegistry(
          installedPlugins.map(({ pluginId }) => ({ id: pluginId, channels: [] })),
        ),
      });
      metadataSnapshot.index.plugins = installedPlugins;
      return {
        rawConfig: config,
        config,
        activationSourceConfig: options?.activationSourceConfig ?? config,
        autoEnabledReasons: {},
        workspaceDir,
        env: options?.env ?? process.env,
        logger: { info() {}, warn() {}, error() {} },
        manifestRegistry: metadataSnapshot.manifestRegistry,
        metadataSnapshot,
        installRecords: {},
        preferBuiltPluginArtifacts: false,
      };
    });
  });

  it("loads configured channel owners through the canonical root loader", () => {
    const config = { channels: { demo: { enabled: true } } };
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels", config });

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
    installedPlugins = ["sandbox-owner", "research-owner", "broken-plugin"].map((pluginId) =>
      createInstalledPlugin(pluginId),
    );
    mocks.loadOpenClawPlugins.mockImplementationOnce((options) => {
      if (options?.onlyPluginIds?.includes("broken-plugin")) {
        throw new Error("unrelated plugin failed to initialize");
      }
      return createEmptyPluginRegistry();
    });

    expect(() => ensurePluginRegistryLoaded({ scope: "sandbox-backends", config })).not.toThrow();
    expect(requireLoadOptions().onlyPluginIds).toEqual(["research-owner", "sandbox-owner"]);
    expect(mocks.resolveEffectivePluginIds).not.toHaveBeenCalled();
  });

  it("loads installed persisted sandbox owners after configuration switches to Docker", () => {
    const config = {
      agents: { defaults: { sandbox: { backend: "docker" } } },
      plugins: {
        entries: {
          openshell: { enabled: true },
          "broken-plugin": { enabled: true },
        },
      },
    };
    installedPlugins = ["openshell", "broken-plugin"].map((pluginId) =>
      createInstalledPlugin(pluginId),
    );

    ensurePluginRegistryLoaded({
      scope: "sandbox-backends",
      config,
      persistedSandboxBackendIds: ["openshell", "docker", "missing-owner"],
    });

    expect(requireLoadOptions().onlyPluginIds).toEqual(["openshell"]);
  });

  it.each([undefined, "docker", "podman", "ssh"])(
    "does not activate plugins for the built-in sandbox backend %s",
    (backend) => {
      installedPlugins = ["docker", "podman", "ssh"].map((pluginId) =>
        createInstalledPlugin(pluginId),
      );

      ensurePluginRegistryLoaded({
        scope: "sandbox-backends",
        config: { agents: { defaults: { sandbox: { backend } } } },
      });

      expect(requireLoadOptions().onlyPluginIds).toEqual([]);
      expect(mocks.resolveEffectivePluginIds).not.toHaveBeenCalled();
    },
  );

  it("does not guess a differently named sandbox backend owner", () => {
    installedPlugins = [createInstalledPlugin("actual-owner")];

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
