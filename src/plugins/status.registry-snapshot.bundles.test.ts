// Covers detected bundle capabilities in derived and persisted plugin inventory.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import { buildPluginRegistrySnapshotReport } from "./status.js";
import { createColdPluginHermeticEnv } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

const setupBundleInstallFixture = createBundleInstallFixtureFactory(makeTempDir);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("buildPluginRegistrySnapshotReport", () => {
  it.each([
    {
      bundleFormat: "agent",
      enabled: true,
      registrySource: "derived",
      capabilities: ["skills"],
    },
    {
      bundleFormat: "claude",
      enabled: false,
      registrySource: "persisted",
      capabilities: ["skills"],
    },
    {
      bundleFormat: "cursor",
      enabled: true,
      registrySource: "persisted",
      capabilities: ["skills", "commands"],
    },
  ] as const)(
    "preserves $bundleFormat bundle capabilities in $registrySource inventory (enabled=$enabled)",
    async ({ bundleFormat, enabled, registrySource, capabilities }) => {
      const name = `${bundleFormat}-capability-fixture`;
      const { pluginDir, extensionsDir } = setupBundleInstallFixture({ bundleFormat, name });
      const stateDir = path.dirname(extensionsDir);
      const workspaceDir = path.dirname(stateDir);
      const params = {
        config: {
          plugins: {
            load: { paths: [pluginDir] },
            entries: { [name]: { enabled } },
          },
        },
        workspaceDir,
        env: {
          ...createColdPluginHermeticEnv(workspaceDir, { bundledPluginsDir: makeTempDir() }),
          OPENCLAW_STATE_DIR: stateDir,
        },
      };
      if (registrySource === "persisted") {
        await refreshPluginRegistry({ ...params, stateDir, reason: "manual" });
      }

      const report = buildPluginRegistrySnapshotReport(params);

      expect(report.plugins.find((plugin) => plugin.id === name)).toMatchObject({
        format: "bundle",
        bundleFormat,
        bundleCapabilities: capabilities,
        enabled,
      });
      expect(report.registrySource).toBe(registrySource);
    },
  );
});
