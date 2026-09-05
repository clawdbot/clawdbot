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
  loadPluginRegistryHandle: () => loaderState.registry,
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

function createDependencyHealthRegistry(
  pluginId: string,
  overrides: Omit<Parameters<typeof createPluginRecord>[0], "id"> = {},
) {
  return createPluginLoadResult({
    plugins: [
      createPluginRecord({
        id: pluginId,
        dependencyStatus: buildPluginDependencyStatus({
          dependencies: { "missing-runtime": "1.0.0" },
        }),
        ...overrides,
      }),
    ],
  });
}

function createDependencyHealthFixture(
  identity: { pluginId?: string; packageName?: string; bundledDist?: false } = {},
) {
  const rootDir = makeTrackedTempDir("openclaw-plugin-dependency-health", tempDirs);
  const pluginRoot = path.join(rootDir, "plugin");
  const bundledRoot = path.join(rootDir, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(bundledRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: identity.pluginId ?? "missing-dependency-plugin",
    packageName: identity.packageName,
    packageJson: {
      dependencies: { "missing-runtime": "1.0.0", "optional-runtime": "1.0.0" },
      optionalDependencies: { "optional-runtime": "2.0.0" },
    },
  });
  if (identity.bundledDist === false) {
    const packageJsonPath = path.join(pluginRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw: Record<string, unknown>;
    };
    packageJson.openclaw.build = { bundledDist: false };
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
  }
  return {
    fixture,
    reportParams: {
      config: createColdPluginConfig(pluginRoot, fixture.pluginId),
      env: createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: bundledRoot }),
      workspaceDir: rootDir,
    },
  };
}

describe("plugin dependency health projection", () => {
  it.each([
    { mode: "snapshot", load: buildPluginSnapshotReport },
    { mode: "runtime", load: buildPluginDiagnosticsReport },
  ])("surfaces missing required plugin dependencies in $mode inspections", ({ load }) => {
    const { fixture, reportParams } = createDependencyHealthFixture();
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId);

    const report = load(reportParams);

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

  it("uses prepared manifest facts when runtime records omit dependency metadata", () => {
    const { fixture, reportParams } = createDependencyHealthFixture();
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId, {
      dependencyStatus: undefined,
    });

    const report = buildPluginDiagnosticsReport(reportParams);

    expect(report.plugins[0]?.dependencyStatus).toEqual(
      expect.objectContaining({
        requiredInstalled: false,
        missing: ["missing-runtime"],
        missingOptional: ["optional-runtime"],
      }),
    );
    expect(report.plugins[0]?.status).toBe("error");
  });

  it("does not project package-local dependency health onto bundled plugins", () => {
    const { fixture, reportParams } = createDependencyHealthFixture();
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId, {
      dependencyStatus: undefined,
      origin: "bundled",
    });

    const report = buildPluginDiagnosticsReport(reportParams);

    expect(report.plugins[0]?.dependencyStatus).toBeUndefined();
    expect(report.plugins[0]?.status).toBe("loaded");
    expect(report.diagnostics).toEqual([]);
  });

  it("projects runtime dependency health onto generic source-external bundled plugins", () => {
    const { fixture, reportParams } = createDependencyHealthFixture({ bundledDist: false });
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId, {
      dependencyStatus: undefined,
      origin: "bundled",
    });

    const report = buildPluginDiagnosticsReport(reportParams);

    expect(report.plugins[0]?.dependencyStatus).toEqual(
      expect.objectContaining({ requiredInstalled: false, missing: ["missing-runtime"] }),
    );
    expect(report.plugins[0]?.status).toBe("error");
  });

  it("projects dependency health onto bundled official plugins distributed externally", () => {
    const { fixture, reportParams } = createDependencyHealthFixture({
      pluginId: "discord",
      packageName: "@openclaw/discord",
    });
    loaderState.registry = createDependencyHealthRegistry(fixture.pluginId, {
      dependencyStatus: undefined,
      origin: "bundled",
      packageName: "@openclaw/discord",
    });

    const report = buildPluginDiagnosticsReport(reportParams);

    expect(report.plugins[0]?.dependencyStatus).toEqual(
      expect.objectContaining({ requiredInstalled: false, missing: ["missing-runtime"] }),
    );
    expect(report.plugins[0]?.status).toBe("error");
  });

  it("preserves an existing error diagnostic when dependency health also fails", () => {
    const registry = createDependencyHealthRegistry("existing-plugin-error", {
      status: "error",
      error: "Cannot find module 'missing-runtime'",
    });
    registry.diagnostics.push({
      level: "error",
      pluginId: "existing-plugin-error",
      message: "already recorded",
    });

    const report = projectPluginDependencyHealth(registry);

    expect(report.plugins[0]?.status).toBe("error");
    expect(report.plugins[0]?.error).toContain("Cannot find module 'missing-runtime'");
    expect(report.plugins[0]?.error).toContain("Install the plugin dependencies");
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]?.message).toContain("already recorded");
    expect(report.diagnostics[0]?.message).toContain("Install the plugin dependencies");
  });
});
