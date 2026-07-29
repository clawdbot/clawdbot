// Bundled plugin load-path tests cover doctor validation of bundled plugin paths.
import path from "node:path";
import { bundledDistPluginRootAt, bundledPluginRootAt } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundledPluginSource } from "../../../plugins/bundled-sources.js";
import * as bundledSources from "../../../plugins/bundled-sources.js";
import {
  collectBundledPluginLoadPathWarnings,
  maybeRepairBundledPluginLoadPaths,
  scanBundledPluginLoadPathMigrations,
} from "./bundled-plugin-load-paths.js";

function bundled(pluginId: string, localPath: string): BundledPluginSource {
  return {
    pluginId,
    localPath,
    npmSpec: `@openclaw/${pluginId}`,
  };
}

function mockBundledSource(pluginId: string, localPath: string) {
  vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
    new Map([[pluginId, bundled(pluginId, localPath)]]),
  );
}

function createPluginLoadPathConfig(
  paths: Array<string | number>,
): Parameters<typeof maybeRepairBundledPluginLoadPaths>[0] {
  return {
    plugins: {
      load: {
        paths,
      },
    },
  } as unknown as Parameters<typeof maybeRepairBundledPluginLoadPaths>[0];
}

describe("bundled plugin load path repair", () => {
  beforeEach(() => {
    const packageRoot = "/app/node_modules/openclaw";
    mockBundledSource("feishu", bundledDistPluginRootAt(packageRoot, "feishu"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects legacy bundled plugin paths that still point at source extensions", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = bundledPluginRootAt(packageRoot, "feishu");
    const bundledPath = bundledDistPluginRootAt(packageRoot, "feishu");
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
      new Map([["feishu", bundled("feishu", bundledPath)]]),
    );

    const hits = scanBundledPluginLoadPathMigrations({
      plugins: {
        load: {
          paths: [legacyPath],
        },
      },
    });

    expect(hits).toEqual([
      {
        pluginId: "feishu",
        fromPath: legacyPath,
        toPath: bundledPath,
        pathLabel: "plugins.load.paths",
      },
    ]);
  });

  it("removes legacy bundled paths during doctor repair", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = bundledPluginRootAt(packageRoot, "feishu");
    const bundledPath = bundledDistPluginRootAt(packageRoot, "feishu");
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
      new Map([["feishu", bundled("feishu", bundledPath)]]),
    );

    const result = maybeRepairBundledPluginLoadPaths({
      plugins: {
        load: {
          paths: [legacyPath],
        },
      },
    });

    expect(result.changes).toEqual([
      `- plugins.load.paths: removed bundled feishu path alias ${legacyPath}`,
    ]);
    expect(result.config.plugins?.load?.paths).toStrictEqual([]);
  });

  it("removes current packaged bundled paths during doctor repair", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const bundledPath = bundledDistPluginRootAt(packageRoot, "feishu");
    mockBundledSource("feishu", bundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([bundledPath]));

    expect(result.config.plugins?.load?.paths).toStrictEqual([]);
  });

  it("removes stale bundled paths from old versioned OpenClaw package roots", () => {
    const currentPackageRoot = path.resolve("node_modules", "openclaw");
    const stalePackageRoot = path.resolve(
      "pnpm-global",
      ".pnpm",
      "openclaw@2026.3.28_@napi-rs+canvas@0.1.97",
      "node_modules",
      "openclaw",
    );
    const currentBundledPath = bundledDistPluginRootAt(currentPackageRoot, "feishu");
    const staleBundledPath = bundledDistPluginRootAt(stalePackageRoot, "feishu");
    mockBundledSource("feishu", currentBundledPath);

    const result = maybeRepairBundledPluginLoadPaths(
      createPluginLoadPathConfig([staleBundledPath, "/custom/path"]),
    );

    expect(result.changes).toEqual([
      `- plugins.load.paths: removed bundled feishu path alias ${staleBundledPath}`,
    ]);
    expect(result.config.plugins?.load?.paths).toStrictEqual(["/custom/path"]);
  });

  it("removes stale legacy bundled paths from old versioned OpenClaw package roots", () => {
    const currentPackageRoot = path.resolve("node_modules", "openclaw");
    const stalePackageRoot = path.resolve(
      "pnpm-global",
      ".pnpm",
      "openclaw@2026.3.28_@napi-rs+canvas@0.1.97",
      "node_modules",
      "openclaw",
    );
    const currentBundledPath = bundledDistPluginRootAt(currentPackageRoot, "feishu");
    const staleLegacyPath = bundledPluginRootAt(stalePackageRoot, "feishu");
    mockBundledSource("feishu", currentBundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([staleLegacyPath]));

    expect(result.changes).toEqual([
      `- plugins.load.paths: removed bundled feishu path alias ${staleLegacyPath}`,
    ]);
    expect(result.config.plugins?.load?.paths).toStrictEqual([]);
  });

  it("does not remove arbitrary missing paths that happen to use the bundled dist layout", () => {
    const currentPackageRoot = path.resolve("node_modules", "openclaw");
    const customPath = path.resolve("elsewhere", "dist", "extensions", "feishu");
    mockBundledSource("feishu", bundledDistPluginRootAt(currentPackageRoot, "feishu"));

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([customPath]));

    expect(result.changes).toEqual([]);
    expect(result.config).toEqual(createPluginLoadPathConfig([customPath]));
  });

  it("derives legacy paths from the bundled directory name instead of plugin id", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = bundledPluginRootAt(packageRoot, "kimi-coding");
    const bundledPath = bundledDistPluginRootAt(packageRoot, "kimi-coding");
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
      new Map([["kimi", bundled("kimi", bundledPath)]]),
    );

    const hits = scanBundledPluginLoadPathMigrations({
      plugins: {
        load: {
          paths: [legacyPath],
        },
      },
    });

    expect(hits).toEqual([
      {
        pluginId: "kimi",
        fromPath: legacyPath,
        toPath: bundledPath,
        pathLabel: "plugins.load.paths",
      },
    ]);
  });

  it("matches legacy bundled paths with a trailing slash", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = `${bundledPluginRootAt(packageRoot, "feishu")}${path.sep}`;
    const bundledPath = bundledDistPluginRootAt(packageRoot, "feishu");
    mockBundledSource("feishu", bundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([legacyPath]));

    expect(result.config.plugins?.load?.paths).toStrictEqual([]);
  });

  it("removes dist-runtime bundled paths", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    const bundledPath = path.join(packageRoot, "dist-runtime", "extensions", "feishu");
    mockBundledSource("feishu", bundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([legacyPath]));

    expect(result.config.plugins?.load?.paths).toStrictEqual([]);
  });

  it("preserves non-string path entries when repairing legacy bundled paths", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    const bundledPath = path.join(packageRoot, "dist", "extensions", "feishu");
    mockBundledSource("feishu", bundledPath);

    const cfg = createPluginLoadPathConfig([legacyPath, 42, "/other/path"]);

    const result = maybeRepairBundledPluginLoadPaths(cfg);

    expect(result.config.plugins?.load?.paths).toEqual([42, "/other/path"]);
  });

  it("formats a doctor hint for legacy bundled plugin paths", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    const bundledPath = path.join(packageRoot, "dist", "extensions", "feishu");

    const warnings = collectBundledPluginLoadPathWarnings({
      hits: [
        {
          pluginId: "feishu",
          fromPath: legacyPath,
          toPath: bundledPath,
          pathLabel: "plugins.load.paths",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      `- plugins.load.paths: bundled plugin path "${legacyPath}" still aliases feishu; OpenClaw loads the packaged bundled plugin from "${bundledPath}".`,
      '- Run "openclaw doctor --fix" to remove these redundant bundled plugin paths.',
    ]);
  });

  it("ignores bundled plugins that already resolve to source extensions", () => {
    const sourcePath = path.resolve("repo", "openclaw", "extensions", "feishu");
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
      new Map([["feishu", bundled("feishu", sourcePath)]]),
    );

    const hits = scanBundledPluginLoadPathMigrations({
      plugins: {
        load: {
          paths: [sourcePath],
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });
});
