import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["runtime", "cli"] as const)(
  "keeps effective enablement separate from reason-only activation (%s)",
  async (surface) => {
    const imported = path.join(makePluginLoaderTempDir(), "imported");
    const plugin = writePlugin({
      id: "admission-contract",
      filename: "index.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported");
module.exports = { id: "admission-contract", register() {} };`,
    });
    const config: OpenClawConfig = {
      plugins: { enabled: true, slots: { memory: "none" } },
    };
    const options = {
      config,
      manifestRegistry: {
        plugins: [
          {
            id: plugin.id,
            origin: "bundled" as const,
            rootDir: plugin.dir,
            source: plugin.file,
            manifestPath: path.join(plugin.dir, "openclaw.plugin.json"),
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            configSchema: EMPTY_PLUGIN_SCHEMA,
          },
        ],
        diagnostics: [],
      },
      installRecords: {},
      onlyPluginIds: [plugin.id],
      activate: false,
      cache: false,
      autoEnabledReasons: { [plugin.id]: ["reason without effective enablement"] },
    };
    const registry =
      surface === "runtime"
        ? loadOpenClawPlugins(options)
        : await loadOpenClawPluginCliRegistry(options);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject({
      id: plugin.id,
      enabled: false,
      activated: false,
      status: "disabled",
      activationSource: "disabled",
      activationReason: "bundled (disabled by default)",
      error: "bundled (disabled by default)",
    });
    expect(registry.cliRegistrars).toHaveLength(0);
    expect(fs.existsSync(imported)).toBe(false);
  },
);

it.each([false, true])("keeps scoped forced setup selection with setupEntry=%s", (setupEntry) => {
  useNoBundledPlugins();
  const markers = makePluginLoaderTempDir();
  const fullMarker = path.join(markers, "full-imported");
  const setupMarker = path.join(markers, "setup-imported");
  const channelSource = `const channel = {
  id: "admission-channel",
  meta: { id: "admission-channel", label: "Admission Channel" },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
};`;
  const plugin = writePlugin({
    id: "admission-setup",
    filename: "index.cjs",
    body: `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "imported");
${channelSource}
module.exports = { id: "admission-setup", register(api) { api.registerChannel({ plugin: channel }); } };`,
  });
  if (setupEntry) {
    writePlugin({
      id: plugin.id,
      dir: plugin.dir,
      filename: "setup.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "imported");
${channelSource}
module.exports = { plugin: channel };`,
    });
  }
  writePluginMetadata({
    dir: plugin.dir,
    id: plugin.id,
    channels: ["admission-channel"],
    packageJson: {
      name: "@example/admission-setup",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        ...(setupEntry ? { setupEntry: "./setup.cjs" } : {}),
      },
    },
  });
  const registry = loadOpenClawPlugins({
    config: { plugins: { allow: [plugin.id], load: { paths: [plugin.dir] } } },
    onlyPluginIds: [plugin.id],
    includeSetupOnlyChannelPlugins: true,
    forceSetupOnlyChannelPlugins: true,
    activate: false,
    cache: false,
  });
  expect(registry.plugins.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: plugin.id, status: "loaded" },
  ]);
  expect(registry.channelSetups.map(({ plugin: channel }) => channel.id)).toEqual([
    "admission-channel",
  ]);
  expect(registry.channels).toHaveLength(0);
  expect(fs.existsSync(setupMarker)).toBe(setupEntry);
  expect(fs.existsSync(fullMarker)).toBe(!setupEntry);
});
