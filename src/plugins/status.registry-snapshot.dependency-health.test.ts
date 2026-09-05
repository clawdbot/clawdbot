import fs from "node:fs";
import path from "node:path";
// Covers dependency-health projection for bundled-origin plugins in registry snapshots.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { buildPluginRegistrySnapshotReport } from "./status.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const requireRecord = createRequireRecord("record", "expected-non-array-record");

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function snapshotBundledPluginWithMissingDependency(params: {
  pluginId: string;
  bundledDist?: false;
}) {
  const tempRoot = makeTrackedTempDir("openclaw-plugin-status-deps", tempDirs);
  const bundledRoot = path.join(tempRoot, "bundled");
  const pluginRoot = path.join(bundledRoot, params.pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: params.pluginId,
    packageJson: { dependencies: { "missing-plugin-local-dependency": "1.0.0" } },
  });
  if (params.bundledDist === false) {
    // Source builds compile these plugins into the bundled tree but leave their
    // dependencies plugin-local, so the bundled origin alone must not hide them.
    const packageJsonPath = path.join(pluginRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw: Record<string, unknown>;
    };
    packageJson.openclaw.build = { bundledDist: false };
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
  }
  const report = buildPluginRegistrySnapshotReport({
    config: { plugins: { entries: { [params.pluginId]: { enabled: true } } } },
    env: createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: bundledRoot }),
  });
  const plugin = report.plugins.find((entry) => entry.id === params.pluginId);
  if (!plugin) {
    throw new Error(`Expected plugin ${params.pluginId}`);
  }
  return { report, plugin: requireRecord(plugin) };
}

describe("buildPluginRegistrySnapshotReport dependency health", () => {
  it("does not project package-local dependency health onto bundled plugins", () => {
    const { report, plugin } = snapshotBundledPluginWithMissingDependency({
      pluginId: "bundled-demo",
    });

    expect(plugin).toMatchObject({ origin: "bundled", status: "loaded" });
    expect(plugin.dependencyStatus).toBeUndefined();
    expect(report.diagnostics).toEqual([]);
  });

  it("projects dependency health onto bundled plugins distributed outside the root package", () => {
    const { report, plugin } = snapshotBundledPluginWithMissingDependency({
      pluginId: "source-external-demo",
      bundledDist: false,
    });

    expect(plugin).toMatchObject({ origin: "bundled", status: "error" });
    expect(requireRecord(plugin.dependencyStatus)).toMatchObject({
      requiredInstalled: false,
      missing: ["missing-plugin-local-dependency"],
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "source-external-demo",
        message: expect.stringContaining("required dependencies are missing"),
      }),
    );
  });
});
