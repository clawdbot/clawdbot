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
        expect(registry.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
          origin: "bundled",
          rootDir: pluginRoot,
          source: path.join(
            pluginRoot,
            alias.endsWith("directory") && fs.existsSync(path.join(pluginRoot, "dist", "index.js"))
              ? "dist/index.js"
              : "index.ts",
          ),
        });
      });
    },
  );
});
