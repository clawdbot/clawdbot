// Plugin control-plane cold-import tests guard setup and plugin metadata paths against runtime-heavy imports.
import { afterEach, describe, expect, it } from "vitest";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { buildAuthChoiceGroups, formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { listManifestInstalledChannelIds } from "./channel-setup/discovery.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-command-cold-imports", tempDirs);
}

afterEach(() => {
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

    const authChoice = buildAuthChoiceGroups({
      store: {} as never,
      includeSkip: false,
      config: cfg,
      workspaceDir,
      env,
    })
      .groups.flatMap((group) => group.options)
      .find((choice) => choice.value === plugin.authChoiceId);
    expect(authChoice?.label).toBe("Cold Provider API key");
    expect(authChoice?.groupId).toBe(plugin.providerId);
    expect(
      formatAuthChoiceChoicesForCli({
        config: cfg,
        workspaceDir,
        env,
      }).split("|"),
    ).toContain(plugin.authChoiceId);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });
});
