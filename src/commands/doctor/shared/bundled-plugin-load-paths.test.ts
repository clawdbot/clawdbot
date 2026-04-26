import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundledDistPluginRootAt,
  bundledPluginRootAt,
} from "../../../../test/helpers/bundled-plugin-paths.js";
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
    expect(result.config.plugins?.load?.paths).toEqual([]);
  });

  it("removes current packaged bundled paths during doctor repair", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const bundledPath = bundledDistPluginRootAt(packageRoot, "feishu");
    mockBundledSource("feishu", bundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([bundledPath]));

    expect(result.config.plugins?.load?.paths).toEqual([]);
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

    expect(result.config.plugins?.load?.paths).toEqual([]);
  });

  it("removes dist-runtime bundled paths", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    const bundledPath = path.join(packageRoot, "dist-runtime", "extensions", "feishu");
    mockBundledSource("feishu", bundledPath);

    const result = maybeRepairBundledPluginLoadPaths(createPluginLoadPathConfig([legacyPath]));

    expect(result.config.plugins?.load?.paths).toEqual([]);
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
      expect.stringContaining(`plugins.load.paths: bundled plugin path "${legacyPath}"`),
      expect.stringContaining('Run "openclaw doctor --fix"'),
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

    expect(hits).toEqual([]);
  });
});
