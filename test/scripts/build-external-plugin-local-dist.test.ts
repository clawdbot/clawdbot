import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("external plugin local dist build", () => {
  it("keeps excluded plugin graphs isolated and their runtime metadata loadable", async () => {
    const repoRoot = fs.realpathSync(tempDirs.make("openclaw-isolated-plugin-graphs-"));
    const plugins = [
      { id: "external-esm", runtimeFormat: "esm", publishToNpm: true },
      { id: "external-cjs", runtimeFormat: "cjs", publishToNpm: true },
      { id: "private-plugin", runtimeFormat: "esm", publishToNpm: false },
    ];
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.0",
        type: "module",
        files: ["dist/**", ...plugins.map(({ id }) => `!dist/extensions/${id}/**`)],
      }),
    );
    for (const { id, runtimeFormat, publishToNpm } of plugins) {
      const pluginRoot = path.join(repoRoot, "extensions", id);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: `@openclaw/${id}`,
          version: "1.0.0",
          type: "module",
          openclaw: {
            extensions: ["./index.ts"],
            setupEntry: "./setup-entry.ts",
            build: { runtimeFormat },
            release: { publishToNpm },
          },
        }),
      );
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({ id }));
      fs.writeFileSync(
        path.join(pluginRoot, "runtime-api.ts"),
        `export const identity = ${JSON.stringify(id)};`,
      );
      for (const entry of ["index.ts", "setup-entry.ts"]) {
        fs.writeFileSync(
          path.join(pluginRoot, entry),
          'export { identity } from "./runtime-api.js";',
        );
      }
    }
    await expect(
      buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" }),
    ).resolves.toMatchObject({
      pluginDirs: plugins.map(({ id }) => id).toSorted(),
    });
    copyBundledPluginMetadata({ repoRoot, env: {} });
    expect(fs.readdirSync(path.join(repoRoot, "dist"))).toEqual(["extensions"]);
    for (const { id, runtimeFormat } of plugins) {
      const pluginRoot = path.join(repoRoot, "dist/extensions", id);
      const metadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      expect(metadata.openclaw.extensions).toEqual([`./index${extension}`]);
      expect(metadata.openclaw.setupEntry).toBe(`./setup-entry${extension}`);
      expect(fs.existsSync(path.join(repoRoot, "extensions", id, "dist"))).toBe(false);
      const probe = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import { pathToFileURL } from "node:url";
        const root = pathToFileURL(process.cwd() + "/");
        const pkg = JSON.parse(readFileSync(new URL("package.json", root)));
        for (const entry of [...pkg.openclaw.extensions, pkg.openclaw.setupEntry]) {
          assert.equal((await import(new URL(entry, root))).identity, ${JSON.stringify(id)});
        }
      `,
        ],
        { cwd: pluginRoot, encoding: "utf8" },
      );
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
    }
  });

  it.for([false, true])(
    "retains each plugin's dependency owner and the shared host SDK (relocate=%s)",
    async (relocate, context) => {
      // Windows junctions remain absolute; release relocation uses POSIX symlinks.
      if (relocate && process.platform === "win32") {
        context.skip();
      }
      const repoRoot = fs.realpathSync(tempDirs.make("openclaw-external-plugin-owners-"));
      fs.writeFileSync(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "1.0.0",
          type: "module",
          exports: { "./plugin-sdk/probe": "./probe.js" },
        }),
      );
      fs.writeFileSync(path.join(repoRoot, "probe.js"), "export const shared = {};\n");
      for (const [pluginId, version] of [
        ["first", "1.0.0"],
        ["second", "2.0.0"],
      ] as const) {
        const packageDir = path.join(repoRoot, "extensions", pluginId);
        const dependencyDir = path.join(packageDir, "node_modules", "private-dep");
        fs.mkdirSync(dependencyDir, { recursive: true });
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({
            name: `@openclaw/${pluginId}`,
            version: "1.0.0",
            type: "module",
            dependencies: { "private-dep": version },
            peerDependencies: { openclaw: "1.0.0" },
            openclaw: {
              extensions: ["./index.ts"],
              build: { bundledDist: false },
              release: { publishToNpm: true },
            },
          }),
        );
        fs.writeFileSync(
          path.join(dependencyDir, "package.json"),
          JSON.stringify({ name: "private-dep", version, type: "module", main: "index.js" }),
        );
        fs.writeFileSync(
          path.join(dependencyDir, "index.js"),
          `export default ${JSON.stringify(version)};\n`,
        );
        fs.symlinkSync(
          process.platform === "win32" ? repoRoot : "../../..",
          path.join(packageDir, "node_modules", "openclaw"),
          process.platform === "win32" ? "junction" : "dir",
        );
        fs.writeFileSync(
          path.join(packageDir, "index.ts"),
          'export { default as version } from "private-dep";\nexport { shared } from "openclaw/plugin-sdk/probe";\n',
        );
        fs.writeFileSync(
          path.join(packageDir, "openclaw.plugin.json"),
          JSON.stringify({ id: pluginId, skills: ["./node_modules/private-dep"] }),
        );
      }
      await buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" });
      copyBundledPluginMetadata({ repoRoot, env: {} });
      // Repeating postbuild must not remove source packages through the output link.
      copyBundledPluginMetadata({ repoRoot, env: {} });
      let runtimeRoot = repoRoot;
      if (relocate) {
        runtimeRoot = fs.realpathSync(tempDirs.make("openclaw-external-plugin-relocated-"));
        fs.cpSync(repoRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
        fs.rmSync(repoRoot, { recursive: true });
      }
      const entryUrl = (pluginId: string) =>
        pathToFileURL(path.join(runtimeRoot, "dist", "extensions", pluginId, "index.js")).href;
      const stagedDir = path.join(runtimeRoot, "staged", "first");
      fs.cpSync(path.join(runtimeRoot, "dist", "extensions", "first"), stagedDir, {
        recursive: true,
      });
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      const first = await import(${JSON.stringify(entryUrl("first"))});
      const second = await import(${JSON.stringify(entryUrl("second"))});
      const staged = await import(${JSON.stringify(pathToFileURL(path.join(stagedDir, "index.js")).href)});
      console.log(JSON.stringify({ versions: [first.version, second.version, staged.version], shared: first.shared === second.shared && first.shared === staged.shared }));
    `,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({ versions: ["1.0.0", "2.0.0", "1.0.0"], shared: true });
      for (const pluginId of ["first", "second"]) {
        const runtimeModules = path.join(
          runtimeRoot,
          "dist",
          "extensions",
          pluginId,
          "node_modules",
        );
        if (process.platform !== "win32") {
          expect(path.isAbsolute(fs.readlinkSync(runtimeModules))).toBe(false);
        }
        expect(fs.realpathSync(runtimeModules)).toBe(
          path.join(runtimeRoot, "extensions", pluginId, "node_modules"),
        );
      }
    },
  );

  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();

    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "extensions/diffs",
        "extensions/diffs-language-pack",
        "extensions/discord",
        "extensions/feishu",
        "extensions/matrix",
        "extensions/slack",
        "extensions/sms",
        "extensions/mxc",
        "extensions/whatsapp",
        "extensions/codex",
        "extensions/diagnostics-otel",
        "extensions/msteams",
        "extensions/visitor-access",
      ]),
    );
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("leaves Docker-selected external plugin compilation on the unified build path", () => {
    expect(
      listExternalPluginLocalDistPackageDirs({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
      }),
    ).toEqual([]);
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
