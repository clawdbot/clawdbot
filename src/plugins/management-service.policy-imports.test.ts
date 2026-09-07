import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

vi.mock("./management-install.js", () => {
  throw new Error("Plugin policy changes must not load the installation implementation");
});
vi.mock("./management-uninstall.js", () => {
  throw new Error("Plugin policy changes must not load the removal implementation");
});

vi.mock("./install-persistence.js", () => {
  throw new Error("Plugin policy changes must not load install persistence");
});
vi.mock("./status.js", () => {
  throw new Error("Bundled plugin policy changes must not load runtime diagnostics");
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  closeOpenClawStateDatabaseForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("persists CLI plugin policy without loading installation, removal, or runtime diagnostics", async () => {
  const stateDir = makePluginLoaderTempDir();
  const bundledDir = makePluginLoaderTempDir();
  const pluginId = "policy-only";
  writePlugin({
    id: pluginId,
    dir: path.join(bundledDir, pluginId),
    filename: "index.cjs",
    body: `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  });
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    async () => {
      await writeConfigFile({ plugins: { entries: { [pluginId]: { enabled: false } } } });
      const { runPluginsEnableCommand, runPluginsDisableCommand } =
        await import("../cli/plugins-cli.runtime.js");
      await runPluginsEnableCommand(pluginId);
      expect(
        (await readConfigFileSnapshotForWrite()).snapshot.sourceConfig.plugins?.entries?.[pluginId]
          ?.enabled,
      ).toBe(true);
      await runPluginsDisableCommand(pluginId);
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")).plugins.entries[
          pluginId
        ].enabled,
      ).toBe(false);
    },
  );
});
