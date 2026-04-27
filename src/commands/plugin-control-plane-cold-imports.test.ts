import { afterEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { buildAuthChoiceOptions, formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { listManifestInstalledChannelIds } from "./channel-setup/discovery.js";
import { resolveProviderCatalogPluginIdsForFilter } from "./models/list.provider-catalog.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-command-cold-imports", tempDirs);
}

afterEach(() => {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("command control-plane plugin discovery", () => {
  it("resolves channel setup metadata without importing plugin runtime", () => {
    const plugin = createColdPluginFixture({ rootDir: makeTempDir() });
    const workspaceDir = makeTempDir();
    const cfg = createColdPluginConfig(plugin.rootDir, plugin.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir);

    expect(
      listManifestInstalledChannelIds({
        cfg,
        workspaceDir,
        env,
      }),
    ).toContain(plugin.channelId);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });

  it("builds onboarding auth choices from manifest metadata without importing plugin runtime", () => {
    const plugin = createColdPluginFixture({ rootDir: makeTempDir() });
    const workspaceDir = makeTempDir();
    const cfg = createColdPluginConfig(plugin.rootDir, plugin.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir);

    expect(
      buildAuthChoiceOptions({
        store: {} as never,
        includeSkip: false,
        config: cfg,
        workspaceDir,
        env,
      }),
    ).toContainEqual(
      expect.objectContaining({
        value: plugin.authChoiceId,
        label: "Cold Provider API key",
        groupId: plugin.providerId,
      }),
    );
    expect(
      formatAuthChoiceChoicesForCli({
        config: cfg,
        workspaceDir,
        env,
      }).split("|"),
    ).toContain(plugin.authChoiceId);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });

  it("resolves models-list provider ownership without importing plugin runtime", async () => {
    const plugin = createColdPluginFixture({ rootDir: makeTempDir() });
    const workspaceDir = makeTempDir();
    const cfg = createColdPluginConfig(plugin.rootDir, plugin.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir, { disablePersistedRegistry: false });

    await refreshPluginRegistry({
      config: cfg,
      workspaceDir,
      env,
      reason: "manual",
    });
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);

    await expect(
      resolveProviderCatalogPluginIdsForFilter({
        cfg,
        env,
        providerFilter: plugin.providerId,
      }),
    ).resolves.toEqual([plugin.pluginId]);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });
});
