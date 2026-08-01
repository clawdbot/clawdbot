import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";
import { buildPluginDiagnosticsReport, buildPluginSnapshotReport } from "./status.js";
import { createPluginLoadResult, createPluginRecord } from "./status.test-fixtures.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const loaderState = vi.hoisted(() => ({
  registry: undefined as
    | ReturnType<typeof import("./status.test-fixtures.js").createPluginLoadResult>
    | undefined,
}));

vi.mock("./loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loader.js")>()),
  loadOpenClawPlugins: () => loaderState.registry,
}));

vi.mock("./runtime/metadata-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/metadata-registry-loader.js")>()),
  loadPluginMetadataRegistrySnapshot: () => loaderState.registry,
}));

const tempDirs: string[] = [];

afterEach(() => {
  loaderState.registry = undefined;
  cleanupTrackedTempDirs(tempDirs);
});

function createDependencyHealthRegistry(pluginId: string) {
  return createPluginLoadResult({
    plugins: [
      createPluginRecord({
        id: pluginId,
        dependencyStatus: buildPluginDependencyStatus({
          dependencies: { "missing-runtime": "1.0.0" },
        }),
      }),
    ],
  });
}

describe("plugin dependency health projection", () => {
  it.each([
    { mode: "snapshot", load: buildPluginSnapshotReport },
    { mode: "runtime", load: buildPluginDiagnosticsReport },
  ])("surfaces missing required plugin dependencies in $mode inspections", ({ load }) => {
    const rootDir = makeTrackedTempDir("openclaw-plugin-dependency-health", tempDirs);
    const pluginRoot = path.join(rootDir, "plugin");
    const bundledRoot = path.join(rootDir, "bundled");
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(bundledRoot);
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "missing-dependency-plugin",
      packageJson: { dependencies: { "missing-runtime": "1.0.0" } },
    });
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId);

    const report = load({
      config: createColdPluginConfig(pluginRoot, fixture.pluginId),
      env: createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: bundledRoot }),
      workspaceDir: rootDir,
    });

    expect(report.plugins[0]).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("missing-runtime"),
      }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "missing-dependency-plugin",
        message: expect.stringContaining("reinstall/update the plugin"),
      }),
    );
  });

  it("preserves an existing error diagnostic when dependency health also fails", () => {
    const registry = createDependencyHealthRegistry("existing-plugin-error");
    registry.diagnostics.push({
      level: "error",
      pluginId: "existing-plugin-error",
      message: "already recorded",
    });

    const report = projectPluginDependencyHealth(registry);

    expect(report.plugins[0]?.status).toBe("error");
    expect(report.diagnostics).toEqual([
      { level: "error", pluginId: "existing-plugin-error", message: "already recorded" },
    ]);
  });
});
