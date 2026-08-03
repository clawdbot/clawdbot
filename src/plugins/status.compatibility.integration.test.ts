/** Integration coverage for plugin status compatibility output and installed-index state. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { buildPluginCompatibilitySnapshotNotices } from "./status.js";

function addStartupActivation(pluginDir: string, onStartup: boolean): void {
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, activation: { onStartup } }, null, 2)}\n`,
    "utf-8",
  );
}

function buildSnapshotCompatibilityNoticeCodes(plugin: { dir: string; file: string; id: string }) {
  const stateDir = makeTempDir();
  return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
    useNoBundledPlugins();
    return buildPluginCompatibilitySnapshotNotices({
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: [plugin.id],
        },
      },
      workspaceDir: plugin.dir,
      env: process.env,
    }).map((notice) => notice.code);
  });
}

describe("plugin compatibility snapshot notices", () => {
  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it("does not report startup compatibility warnings for legacy manifests", () => {
    const plugin = writePlugin({
      id: "legacy-sidecar",
      body: `module.exports = { id: "legacy-sidecar", register() {} };\n`,
    });

    expect(buildSnapshotCompatibilityNoticeCodes(plugin)).toStrictEqual([]);
  });

  it("does not report startup compatibility warnings for explicit startup-lazy manifests", () => {
    const plugin = writePlugin({
      id: "modern-startup-lazy",
      body: `module.exports = { id: "modern-startup-lazy", register() {} };\n`,
    });
    addStartupActivation(plugin.dir, false);

    expect(buildSnapshotCompatibilityNoticeCodes(plugin)).toStrictEqual([]);
  });

  it("reports actual hook-only registrations without activating cold plugin modules", () => {
    const pluginDir = makeTempDir();
    const runtimeMarker = path.join(pluginDir, "runtime-loaded");
    const plugin = writePlugin({
      id: "runtime-hook-only",
      dir: pluginDir,
      body: `module.exports = { id: "runtime-hook-only", register(api) { require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded"); api.on("message_received", () => {}); } };\n`,
    });
    const stateDir = makeTempDir();
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      useNoBundledPlugins();
      const params = { config, workspaceDir: plugin.dir, env: process.env };

      expect(buildPluginCompatibilitySnapshotNotices(params)).toStrictEqual([]);
      expect(fs.existsSync(runtimeMarker)).toBe(false);

      const registry = loadOpenClawPlugins({ ...params, cache: false });
      expect(fs.existsSync(runtimeMarker)).toBe(true);
      expect(registry.typedHooks).toEqual([
        expect.objectContaining({ pluginId: plugin.id, hookName: "message_received" }),
      ]);
      expect(buildPluginCompatibilitySnapshotNotices(params)).toEqual([
        expect.objectContaining({ pluginId: plugin.id, code: "hook-only" }),
      ]);
    });
  });
});
