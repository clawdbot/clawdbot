import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import { loadOpenClawPlugins } from "./loader.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-ordering-")));
  temporaryRoots.push(root);
  return root;
}

function createPlugin(params: {
  pluginRoot: string;
  pluginId: string;
  bundledDist?: boolean;
}): void {
  fs.mkdirSync(params.pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginRoot, "package.json"),
    JSON.stringify({
      name: `@qa/${params.pluginId}`,
      openclaw: {
        extensions: ["./index.cjs"],
        ...(params.bundledDist === undefined ? {} : { build: { bundledDist: params.bundledDist } }),
      },
    }),
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: params.pluginId, configSchema: { type: "object" } }),
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "index.cjs"),
    `module.exports = { id: "${params.pluginId}", register(api) { ` +
      `api.on("gateway_start", () => {}); ` +
      `api.registerService({ id: "${params.pluginId}-service", start() {} }); } };`,
  );
}

function reverseDirectoryEntries(directory: string): void {
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation((entryPath, options) => {
    const entries = readDirectory.call(fs, entryPath, options);
    if (
      path.resolve(String(entryPath)) !== directory ||
      !options ||
      typeof options !== "object" ||
      !("withFileTypes" in options) ||
      !options.withFileTypes
    ) {
      return entries;
    }
    return entries.toSorted((left, right) => {
      const leftName = String(left.name);
      const rightName = String(right.name);
      return leftName > rightName ? -1 : leftName < rightName ? 1 : 0;
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("deterministic plugin discovery ownership", () => {
  it("keeps plugin, equal-priority hook, and service order independent of directory enumeration", () => {
    const stateRoot = createTemporaryRoot();
    const extensionRoot = path.join(stateRoot, "extensions");
    for (const pluginId of ["zeta", "alpha"]) {
      createPlugin({ pluginRoot: path.join(extensionRoot, pluginId), pluginId });
    }
    reverseDirectoryEntries(extensionRoot);

    const registry = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config: { plugins: { allow: ["alpha", "zeta"], slots: { memory: "none" } } },
      env: { OPENCLAW_STATE_DIR: stateRoot, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
    expect(registry.typedHooks.map((hook) => hook.pluginId)).toEqual(["alpha", "zeta"]);
    expect(registry.services.map((service) => service.pluginId)).toEqual(["alpha", "zeta"]);
  });

  it("keeps configured load-path precedence under deterministic directory discovery", () => {
    const stateRoot = createTemporaryRoot();
    const alphaRoot = path.join(stateRoot, "alpha");
    const zetaRoot = path.join(stateRoot, "zeta");
    createPlugin({ pluginRoot: alphaRoot, pluginId: "alpha" });
    createPlugin({ pluginRoot: zetaRoot, pluginId: "zeta" });

    const discovery = discoverOpenClawPlugins({
      extraPaths: [zetaRoot, alphaRoot],
      installRecords: {},
      env: {
        OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });

    expect(discovery.candidates.map((candidate) => candidate.idHint)).toEqual(["zeta", "alpha"]);
  });

  it.each([false, true])(
    "keeps the first configured alias for each physical source (alias first: %s)",
    (aliasFirst) => {
      const stateRoot = createTemporaryRoot();
      const pluginRoot = path.join(stateRoot, "plugin");
      const aliasRoot = path.join(stateRoot, "alias");
      createPlugin({ pluginRoot, pluginId: "ordered-plugin" });
      fs.symlinkSync(pluginRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      const loadPaths = (aliasFirst ? [aliasRoot, pluginRoot] : [pluginRoot, aliasRoot]).map(
        (root) => path.join(root, "index.cjs"),
      );
      const env = {
        OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const runtime = discoverOpenClawPlugins({ extraPaths: loadPaths, installRecords: {}, env });
      const configured = discoverConfiguredPluginLoadPaths({ loadPaths, env, deduplicate: true });
      expect(runtime.candidates.map((candidate) => candidate.source)).toEqual([loadPaths[0]]);
      expect(configured.candidates).toEqual(runtime.candidates);
    },
  );

  it("keeps bundled dist-opt-out source plugin discovery deterministic", () => {
    const packageRoot = createTemporaryRoot();
    const sourceRoot = path.join(packageRoot, "extensions");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(bundledRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/fake.git");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []");
    for (const pluginId of ["zeta", "alpha"]) {
      createPlugin({
        pluginRoot: path.join(sourceRoot, pluginId),
        pluginId,
        bundledDist: false,
      });
    }
    reverseDirectoryEntries(sourceRoot);

    const discovery = discoverOpenClawPlugins({
      installRecords: {},
      env: {
        OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });

    expect(discovery.candidates.map((candidate) => candidate.idHint)).toEqual(["alpha", "zeta"]);
  });

  it("orders manifest-only plugin metadata consistently across filesystem enumeration", () => {
    const root = createTemporaryRoot();
    const home = path.join(root, "home");
    const extensionRoot = path.join(home, ".openclaw", "extensions");
    for (const pluginId of ["zeta", "alpha"]) {
      createPlugin({ pluginRoot: path.join(extensionRoot, pluginId), pluginId });
    }
    reverseDirectoryEntries(extensionRoot);

    const records = listOpenClawPluginManifestMetadata({
      OPENCLAW_HOME: home,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "no-bundled-plugins"),
    });

    expect(
      records.filter((record) => record.origin === "global").map((record) => record.manifest.id),
    ).toEqual(["alpha", "zeta"]);
  });
});
