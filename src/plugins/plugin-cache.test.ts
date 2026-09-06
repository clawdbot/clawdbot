import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import {
  pluginCacheExistsSync,
  readPluginCacheFile,
  readPluginCacheJsonFile,
} from "./plugin-cache-files.js";
import {
  createPluginCache,
  getPluginCacheRoot,
  retirePluginCache,
  transferPluginCacheSetupModules,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retires changed setup graphs while preserving unchanged callbacks and immutable runtime facts", async () => {
  const previous = createPluginCache();
  const next = createPluginCache();
  const previousLoads = getPluginLoaderCacheState(previous);
  const nextLoads = getPluginLoaderCacheState(next);
  const registry = createEmptyPluginRegistry();
  previousLoads.set("cached", registry);
  nextLoads.set("cached", registry);
  previousLoads.beginLoad("pending");
  const changed = new PluginInstance("changed");
  const unchanged = new PluginInstance("unchanged");
  const changedCall = changed.wrap(() => "old");
  const unchangedCall = unchanged.wrap(() => "same");
  previous.setupModules.set("changed", changed);
  previous.setupModules.set("unchanged", unchanged);
  previous.moduleLoaders.set("native-sdk", () => "shared SDK");
  transferPluginCacheSetupModules(previous, next, new Set(["changed"]));
  await retirePluginCache(previous);
  expect(previousLoads.get("cached")).toBeUndefined();
  expect(nextLoads.get("cached")).toBe(registry);
  expect(() => getPluginLoaderCacheState(previous).beginLoad("pending")).toThrow(
    "plugin load reentry",
  );
  previousLoads.finishLoad("pending");
  expect(() => changedCall()).toThrow();
  expect(unchangedCall()).toBe("same");
  expect(previous.moduleLoaders.get("native-sdk")?.("entry")).toBe("shared SDK");
  await retirePluginCache(next);
  expect(nextLoads.get("cached")).toBeUndefined();
  expect(() => unchangedCall()).toThrow();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

describe("plugin package facts", () => {
  it.each(["regular", "boundary"] as const)(
    "shares missing %s files across reader policies until the owner changes",
    (firstPolicy) => {
      const root = tempDirs.make("plugin-missing-policy-");
      const filePath = path.join(root, "catalog.json");
      const readers = {
        regular: () => readPluginCacheJsonFile(filePath),
        boundary: () =>
          readPluginCacheFile({
            rootDir: root,
            relativePath: "catalog.json",
            rejectHardlinks: true,
          }),
      };
      expect(readers[firstPolicy]().ok).toBe(false);
      fs.writeFileSync(filePath, "{}");
      expect(readers.regular().ok).toBe(false);
      expect(readers.boundary().ok).toBe(false);
      withPluginCache(createPluginCache(), () => {
        expect(readers.regular().ok).toBe(true);
        expect(readers.boundary().ok).toBe(true);
      });
      expect(readers[firstPolicy]().ok).toBe(false);
    },
  );

  it("preserves regular-file symlink checks and per-reader size limits", () => {
    const root = tempDirs.make("plugin-regular-policy-");
    const filePath = path.join(root, "catalog.json");
    const alias = path.join(root, "alias.json");
    fs.writeFileSync(filePath, "{}");
    fs.symlinkSync(filePath, alias);
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "catalog.json", rejectHardlinks: false })
        .ok,
    ).toBe(true);
    expect(readPluginCacheJsonFile(alias).ok).toBe(false);
    expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
    expect(readPluginCacheJsonFile(filePath).ok).toBe(true);
    expect(readPluginCacheJsonFile(filePath, { maxBytes: 1 }).ok).toBe(false);
  });

  it.each([2, null])(
    "shares checked bytes across boundary size policies after a %s-byte read",
    (maxBytes) => {
      const root = tempDirs.make("plugin-boundary-size-policy-");
      fs.writeFileSync(path.join(root, "catalog.json"), "{}");
      const params = { rootDir: root, relativePath: "catalog.json", rejectHardlinks: true };
      expect(readPluginCacheFile({ ...params, maxBytes: 1 }).ok).toBe(false);
      expect(readPluginCacheFile({ ...params, maxBytes }).ok).toBe(true);
      const open = vi.spyOn(fs, "openSync");
      expect(readPluginCacheFile({ ...params, maxBytes: 2 }).ok).toBe(true);
      expect(readPluginCacheFile({ ...params, maxBytes: null }).ok).toBe(true);
      expect(readPluginCacheFile({ ...params, maxBytes: 1 }).ok).toBe(false);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("preserves uncapped bundle reads without weakening the default metadata limit", () => {
    const root = tempDirs.make("plugin-unbounded-policy-");
    const contents = Buffer.alloc(16 * 1024 * 1024 + 1, " ");
    fs.writeFileSync(path.join(root, "catalog.json"), contents);
    const params = { rootDir: root, relativePath: "catalog.json", rejectHardlinks: true };
    expect(readPluginCacheFile(params).ok).toBe(false);
    const uncapped = readPluginCacheFile({ ...params, maxBytes: null });
    expect(uncapped.ok && uncapped.contents.length).toBe(contents.length);
    expect(readPluginCacheFile(params).ok).toBe(false);
  });

  it("reuses checked package entries across separate workspace discovery views", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-workspace-entry-facts-"));
    const pluginDir = path.join(parent, "package");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@fixture/shared-entry",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "shared-entry",
        configSchema: { type: "object" },
      }),
    );
    const entry = path.join(pluginDir, "index.js");
    fs.writeFileSync(entry, 'throw new Error("metadata must not execute code");');
    const first = discoverConfiguredPluginLoadPaths({
      loadPaths: [pluginDir],
      workspaceDir: path.join(parent, "a"),
    });
    expect(first.candidates.map((candidate) => candidate.idHint)).toContain("shared-entry");
    const open = vi.spyOn(fs, "openSync");
    const second = discoverConfiguredPluginLoadPaths({
      loadPaths: [pluginDir],
      workspaceDir: path.join(parent, "b"),
    });
    expect(second.candidates[0]?.source).toBe(first.candidates[0]?.source);
    expect(second.candidates[0]?.workspaceDir).toBe(path.join(parent, "b"));
    expect(open.mock.calls.filter(([file]) => String(file) === entry)).toEqual([]);
  });
  it("keeps missing bundle markers fixed until an explicit operation reads a new generation", () => {
    const root = tempDirs.make("plugin-bundle-generation-");
    const metadataDir = path.join(root, ".claude-plugin");
    fs.mkdirSync(metadataDir);
    fs.writeFileSync(path.join(metadataDir, "plugin.json"), JSON.stringify({ name: "fixture" }));
    const format = detectBundleManifestFormat(root);
    expect(format).toBe("claude");
    const before = loadBundleManifest({ rootDir: root, bundleFormat: "claude" });
    expect(before.ok && before.manifest.skills).toEqual([]);
    fs.mkdirSync(path.join(root, "skills"));
    expect(loadBundleManifest({ rootDir: root, bundleFormat: "claude" })).toEqual(before);
    const fresh = withPluginCache(createPluginCache(), () =>
      loadBundleManifest({ rootDir: root, bundleFormat: "claude" }),
    );
    expect(fresh.ok && fresh.manifest.skills).toContain("skills");
  });

  it("shares checked aliases without discarding artifacts resolved before the first file read", () => {
    const parent = tempDirs.make("plugin-alias-generation-");
    const root = path.join(parent, "package");
    const alias = path.join(parent, "alias");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.symlinkSync(root, alias, "dir");
    const aliasRecord = getPluginCacheRoot(alias);
    aliasRecord.artifacts.set("missing-surface", null);
    const first = readPluginCacheFile({
      rootDir: alias,
      relativePath: "package.json",
      rejectHardlinks: true,
    });
    const open = vi.spyOn(fs, "openSync");
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: true }),
    ).toBe(first);
    expect(getPluginCacheRoot(root).artifacts.has("missing-surface")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not use a permissive hardlink read to satisfy a strict root policy", () => {
    const root = tempDirs.make("plugin-hardlink-generation-");
    const source = path.join(root, "source.json");
    fs.writeFileSync(source, "{}");
    fs.linkSync(source, path.join(root, "package.json"));
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: false })
        .ok,
    ).toBe(true);
    expect(
      readPluginCacheFile({ rootDir: root, relativePath: "package.json", rejectHardlinks: true })
        .ok,
    ).toBe(false);
    expect(pluginCacheExistsSync(path.join(root, "missing.json"))).toBe(false);
    fs.writeFileSync(path.join(root, "missing.json"), "{}");
    expect(pluginCacheExistsSync(path.join(root, "missing.json"))).toBe(false);
  });
  it("carries the checked package generation through discovery, manifests, and index hashes", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-plugin-cache-"));
    const bundledDir = path.join(root, "bundled");
    const pluginDir = path.join(bundledDir, "generation-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const packagePath = path.join(pluginDir, "package.json");
    const writeGeneration = (version: string) => {
      const manifest = JSON.stringify({
        id: "generation-owner",
        version,
        configSchema: { type: "object" },
      });
      const packageJson = JSON.stringify({
        name: "@fixture/generation-owner",
        version,
        openclaw: { extensions: ["./index.js"] },
      });
      fs.writeFileSync(manifestPath, manifest);
      fs.writeFileSync(packagePath, packageJson);
      return { manifest, packageJson };
    };
    const first = writeGeneration("1.0.0");
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      'throw new Error("metadata executed runtime");',
    );
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    const discovery = discoverOpenClawPlugins({ env, installRecords: {} });
    expect(
      discovery.candidates.find((candidate) => candidate.idHint === "generation-owner"),
    ).toBeDefined();
    writeGeneration("2.0.0");
    const open = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readFileSync");
    expect(discoverOpenClawPlugins({ env, installRecords: {} })).toBe(discovery);
    const registry = loadPluginManifestRegistryCore({ env, discovery, installRecords: {} });
    const records = buildInstalledPluginIndexRecords({
      candidates: discovery.candidates,
      registry,
      config: {},
      diagnostics: [],
      installRecords: {},
    });
    expect(registry.plugins.find((plugin) => plugin.id === "generation-owner")?.version).toBe(
      "1.0.0",
    );
    expect(records.find((record) => record.pluginId === "generation-owner")).toMatchObject({
      manifestHash: crypto.createHash("sha256").update(first.manifest).digest("hex"),
      packageJson: { hash: crypto.createHash("sha256").update(first.packageJson).digest("hex") },
    });
    for (const filePath of [manifestPath, packagePath]) {
      expect(open.mock.calls.filter(([file]) => String(file) === filePath)).toEqual([]);
      expect(read.mock.calls.filter(([file]) => String(file) === filePath)).toEqual([]);
    }
  });
});
