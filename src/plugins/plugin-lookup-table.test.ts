import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());

vi.mock("../channels/config-presence.js", () => ({
  hasMeaningfulChannelConfig: (value: unknown) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key !== "enabled"),
    ),
  listPotentialConfiguredChannelIds: (
    config: OpenClawConfig,
    env: NodeJS.ProcessEnv,
    options?: { includePersistedAuthState?: boolean },
  ) => listPotentialConfiguredChannelIds(config, env, options),
}));

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

function createManifestRecord(
  plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id" | "origin">,
): PluginManifestRecord {
  return {
    name: plugin.id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/plugins/${plugin.id}`,
    source: `/plugins/${plugin.id}/index.js`,
    manifestPath: `/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  };
}

function createIndex(plugins: readonly PluginManifestRecord[]): PluginRegistrySnapshot {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: `${plugin.id}-hash`,
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: true,
      ...(plugin.enabledByDefault !== undefined
        ? { enabledByDefault: plugin.enabledByDefault }
        : {}),
      startup: {
        sidecar: false,
        memory: false,
        deferConfiguredChannelFullLoadUntilAfterListen: Boolean(
          plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen,
        ),
        agentHarnesses: [],
      },
      compat: [],
    })),
  };
}

const indexDiagnostic = {
  level: "warn",
  source: "/plugins/demo/openclaw.plugin.json",
  message: "indexed warning",
} as const;

const manifestDiagnostic = {
  level: "warn",
  source: "/plugins/demo/openclaw.plugin.json",
  message: "manifest warning",
} as const;

describe("loadPluginLookUpTable", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => Object.keys(config.channels ?? {}));
    loadPluginManifestRegistryForInstalledIndex.mockReset();
  });

  it("builds owner maps and startup ids from one installed manifest registry", async () => {
    const plugins = [
      createManifestRecord({
        id: "telegram",
        origin: "bundled",
        channels: ["telegram"],
        channelConfigs: {
          telegram: {
            schema: { type: "object" },
          },
        },
        commandAliases: [{ name: "telegram-send" }],
        contracts: {
          tools: ["telegram.send"],
        },
      }),
      createManifestRecord({
        id: "openai",
        origin: "bundled",
        providers: ["openai", "openai-codex"],
        modelCatalog: {
          providers: {
            openai: {
              models: [{ id: "gpt-test" }],
            },
          },
        },
        cliBackends: ["codex-cli"],
        setup: {
          providers: [{ id: "openai" }],
        },
      }),
    ];
    const index = {
      ...createIndex(plugins),
      diagnostics: [indexDiagnostic],
    };
    const manifestRegistry: PluginManifestRegistry = {
      plugins,
      diagnostics: [indexDiagnostic, manifestDiagnostic],
    };
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    const { loadPluginLookUpTable } = await import("./plugin-lookup-table.js");

    const table = loadPluginLookUpTable({
      config: {
        channels: {
          telegram: { token: "configured" },
        },
        plugins: {
          slots: { memory: "none" },
        },
      } as OpenClawConfig,
      env: {},
      index,
    });

    expect(table.manifestRegistry).toBe(manifestRegistry);
    expect(table.diagnostics).toEqual([indexDiagnostic, manifestDiagnostic]);
    expect(table.metrics).toMatchObject({
      registrySnapshotMs: expect.any(Number),
      manifestRegistryMs: expect.any(Number),
      startupPlanMs: expect.any(Number),
      ownerMapsMs: expect.any(Number),
      totalMs: expect.any(Number),
      indexPluginCount: 2,
      manifestPluginCount: 2,
      startupPluginCount: 1,
      deferredChannelPluginCount: 0,
    });
    expect(table.byPluginId.get("telegram")?.id).toBe("telegram");
    expect(table.normalizePluginId("openai-codex")).toBe("openai");
    expect(table.owners.channels.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.channelConfigs.get("telegram")).toEqual(["telegram"]);
    expect(table.owners.providers.get("openai")).toEqual(["openai"]);
    expect(table.owners.modelCatalogProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.cliBackends.get("codex-cli")).toEqual(["openai"]);
    expect(table.owners.setupProviders.get("openai")).toEqual(["openai"]);
    expect(table.owners.commandAliases.get("telegram-send")).toEqual(["telegram"]);
    expect(table.owners.contracts.get("tools")).toEqual(["telegram"]);
    expect(table.startup.channelPluginIds).toEqual(["telegram"]);
    expect(table.startup.configuredDeferredChannelPluginIds).toEqual([]);
    expect(table.startup.pluginIds).toEqual(["telegram"]);
  });
});
