import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const checkout = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const tempDirs: string[] = [];
beforeEach(() => vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "0"));
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTrackedTempDirs(tempDirs);
});

describe("running checkout discovery", () => {
  it.each(["default", "source"])(
    "selects the checkout %s tree over a tracked local copy without trusting unrelated plugins",
    (tree) => {
      const stateDir = fs.realpathSync(makeTrackedTempDir("openclaw-checkout-shadow", tempDirs));
      const installRecords = Object.fromEntries(
        ["codex", "diffs", "unrelated"].map((id) => {
          const pluginDir = path.join(stateDir, "extensions", id);
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({ name: `@openclaw/${id}`, openclaw: { extensions: ["./index.js"] } }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({ id, configSchema: { type: "object" } }),
          );
          fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n");
          return [id, { source: "path" as const, installPath: pluginDir, sourcePath: pluginDir }];
        }),
      );
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_DEV_SOURCE_ROOT: checkout,
        OPENCLAW_BUNDLED_PLUGINS_DIR:
          tree === "source" ? path.join(checkout, "extensions") : undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "0",
      };
      withPluginCache(createPluginCache(), () => {
        const discovery = discoverOpenClawPlugins({ env, installRecords });
        const registry = loadPluginManifestRegistryCore({
          env,
          candidates: discovery.candidates,
          installRecords,
        });
        const expectedRoot = path.join(resolveBundledPluginsDir(env)!, "codex");
        const selected = registry.plugins.find((plugin) => plugin.id === "codex");
        expect(selected).toMatchObject({
          origin: "bundled",
          rootDir: expectedRoot,
        });
        expect(registry.plugins.find((plugin) => plugin.id === "unrelated")).toMatchObject({
          origin: "global",
          trustedOfficialInstall: undefined,
        });
        expect(registry.plugins.find((plugin) => plugin.id === "diffs")).toMatchObject({
          origin: "bundled",
          rootDir: path.join(checkout, "extensions", "diffs"),
        });
        const overridden = loadPluginManifestRegistryCore({
          env,
          installRecords,
          config: { plugins: { load: { paths: [installRecords.codex!.installPath] } } },
        });
        expect(overridden.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
          origin: "config",
          rootDir: installRecords.codex!.installPath,
          trustedOfficialInstall: undefined,
        });
        for (const aliasFirst of [true, false]) {
          const paths = [selected!.source, installRecords.codex!.installPath];
          const ordered = loadPluginManifestRegistryCore({
            env,
            installRecords,
            config: { plugins: { load: { paths: aliasFirst ? paths : paths.toReversed() } } },
          });
          expect(ordered.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
            origin: aliasFirst ? "bundled" : "config",
            source: aliasFirst
              ? selected!.source
              : path.join(installRecords.codex!.installPath, "index.js"),
          });
        }
      });
    },
  );

  it.each(["direct file", "symlink file", "direct directory", "symlink directory"])(
    "retains host provenance for a %s configured alias of a bundled entry",
    (alias) => {
      const stateDir = fs.realpathSync(makeTrackedTempDir("openclaw-checkout", tempDirs));
      const sourceRoot = path.join(checkout, "extensions");
      const pluginRoot = path.join(sourceRoot, "codex");
      let selectedRoot = pluginRoot;
      if (alias.startsWith("symlink")) {
        selectedRoot = path.join(stateDir, "linked-plugin");
        fs.symlinkSync(pluginRoot, selectedRoot, process.platform === "win32" ? "junction" : "dir");
      }
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: sourceRoot,
        OPENCLAW_DEV_SOURCE_ROOT: checkout,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "0",
      };
      withPluginCache(createPluginCache(), () => {
        const discovery = discoverOpenClawPlugins({
          env,
          extraPaths: [
            alias.endsWith("directory") ? selectedRoot : path.join(selectedRoot, "index.ts"),
          ],
          installRecords: {},
        });
        const registry = loadPluginManifestRegistryCore({
          env,
          candidates: discovery.candidates,
          installRecords: {},
        });
        // Never keyed on whether the checkout happens to be built: the alias must
        // resolve exactly what the bundled scan resolves in either state.
        expect(registry.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
          origin: "bundled",
          rootDir: pluginRoot,
          source: path.join(pluginRoot, "index.ts"),
        });
      });
    },
  );
});

describe("host provenance across bundled build states", () => {
  // The checkout may or may not be built, so the invariant guard cannot depend on
  // it: a configured alias of a host-owned plugin must classify identically
  // whether the entry resolves to the TypeScript source or to compiled output.
  const aliasShapes = ["direct directory", "symlink directory", "direct file"] as const;
  const buildStates = [
    { label: "built", built: true },
    { label: "unbuilt", built: false },
  ] as const;

  it.each(
    buildStates.flatMap(({ label, built }) =>
      aliasShapes.map((alias) => ({ label, built, alias })),
    ),
  )("keeps a $alias alias bundled in a $label bundled tree", ({ built, alias }) => {
    const stateDir = fs.realpathSync(makeTrackedTempDir("openclaw-host-provenance", tempDirs));
    const bundledDir = fs.realpathSync(makeTrackedTempDir("openclaw-bundled-tree", tempDirs));
    const pluginRoot = path.join(bundledDir, "hosted");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/hosted", openclaw: { extensions: ["./index.ts"] } }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({ id: "hosted", configSchema: { type: "object" } }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n");
    if (built) {
      fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n");
    }
    let aliasRoot = pluginRoot;
    if (alias.startsWith("symlink")) {
      aliasRoot = path.join(stateDir, "linked-hosted");
      fs.symlinkSync(pluginRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    }
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    withPluginCache(createPluginCache(), () => {
      const discovery = discoverOpenClawPlugins({
        env,
        extraPaths: [alias.endsWith("directory") ? aliasRoot : path.join(aliasRoot, "index.ts")],
        installRecords: {},
      });
      // One physical plugin must yield one candidate; a second candidate means the
      // alias resolved a different entry point than the bundled scan did.
      expect(discovery.candidates.filter((candidate) => candidate.idHint === "hosted")).toEqual([
        expect.objectContaining({
          origin: "bundled",
          rootDir: pluginRoot,
          source: path.join(pluginRoot, "index.ts"),
          configSelected: true,
        }),
      ]);
      const registry = loadPluginManifestRegistryCore({
        env,
        candidates: discovery.candidates,
        installRecords: {},
      });
      expect(registry.plugins.find((plugin) => plugin.id === "hosted")).toMatchObject({
        origin: "bundled",
        rootDir: pluginRoot,
        source: path.join(pluginRoot, "index.ts"),
      });
    });
  });
});
