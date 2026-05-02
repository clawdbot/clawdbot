import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
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

    expect(buildSnapshotCompatibilityNoticeCodes(plugin)).toEqual([]);
  });

  it("does not report startup compatibility warnings for explicit startup-lazy manifests", () => {
    const plugin = writePlugin({
      id: "modern-startup-lazy",
      body: `module.exports = { id: "modern-startup-lazy", register() {} };\n`,
    });
    addStartupActivation(plugin.dir, false);

    expect(buildSnapshotCompatibilityNoticeCodes(plugin)).toEqual([]);
  });
});
