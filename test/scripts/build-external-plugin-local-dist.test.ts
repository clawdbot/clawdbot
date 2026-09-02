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
  collectSourceCheckoutPluginBuildEntries,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { resetPluginCache } from "../../src/plugins/plugin-cache.js";
import { resolvePluginRuntimeArtifact } from "../../src/plugins/plugin-runtime-artifact-resolution.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetPluginCache);

describe("external plugin local dist build", () => {
  it("keeps excluded plugin graphs isolated and their runtime metadata loadable", async () => {
    const repoRoot = fs.realpathSync(tempDirs.make("openclaw-isolated-plugin-graphs-"));
    const plugins = [
      { id: "external-esm", runtimeFormat: "esm", publishToNpm: true, bundledDist: true },
      { id: "external-cjs", runtimeFormat: "cjs", publishToNpm: true, bundledDist: true },
      { id: "external-only", runtimeFormat: "cjs", publishToNpm: true, bundledDist: false },
      { id: "private-plugin", runtimeFormat: "esm", publishToNpm: false, bundledDist: true },
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
    for (const { id, runtimeFormat, publishToNpm, bundledDist } of plugins) {
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
            build: { runtimeFormat, bundledDist },
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
    for (const { id, runtimeFormat, bundledDist } of plugins) {
      const pluginRoot = path.join(repoRoot, "dist/extensions", id);
      const metadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      expect(metadata.openclaw.extensions).toEqual([`./index${extension}`]);
      expect(metadata.openclaw.setupEntry).toBe(`./setup-entry${extension}`);
      expect(fs.existsSync(path.join(repoRoot, "extensions", id, "dist"))).toBe(false);
      fs.writeFileSync(
        path.join(pluginRoot, runtimeFormat === "cjs" ? "index.js" : "index.cjs"),
        'throw new Error("stale format must not execute");\n',
      );
      const selected = resolvePluginRuntimeArtifact({
        pluginId: id,
        entryKind: "runtime",
        source: path.join(repoRoot, "extensions", id, "index.ts"),
        rootDir: path.join(repoRoot, "extensions", id),
        origin: "bundled",
        preferBuiltPluginArtifacts: true,
        packageManifest: { build: { bundledDist } },
        registry: createEmptyPluginRegistry(),
      });
      expect(selected.source).toBe(path.join(pluginRoot, `index${extension}`));
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

    const distRoot = path.join(repoRoot, "dist");
    const distEntry = path.join(distRoot, "entry.js");
    const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
    fs.writeFileSync(distEntry, "export {};\n");
    fs.writeFileSync(buildStampPath, "{}\n");
    const readiness = {
      cwd: repoRoot,
      env: {},
      fs,
      distRoot,
      distEntry,
      buildStampPath,
      configFiles: [],
      sourceRoots: [],
      spawnSync: () => ({ status: 1 }),
    };
    expect(resolveBuildRequirement(readiness)).toEqual({ shouldBuild: false, reason: "clean" });
    // Neither a bundled CJS entry nor an external-only entry may be certified
    // by a stale .js file after its selected .cjs output disappears.
    for (const id of ["external-cjs", "external-only"]) {
      const output = path.join(distRoot, "extensions", id, "runtime-api.cjs");
      const contents = fs.readFileSync(output);
      fs.unlinkSync(output);
      fs.writeFileSync(output.replace(/\.cjs$/u, ".js"), "export {};\n");
      expect(resolveBuildRequirement(readiness)).toEqual({
        shouldBuild: true,
        reason: "missing_bundled_plugin_dist_entry",
      });
      fs.writeFileSync(output, contents);
    }
  });

  it.for([
    ["esm", false],
    ["cjs", false],
    ["esm", true],
    ["cjs", true],
  ] as const)(
    "retains %s source dependencies across metadata profiles and the shared host SDK (relocate=%s)",
    async ([runtimeFormat, relocate], context) => {
      // Windows junctions remain absolute; checkout relocation uses POSIX symlinks.
      if (relocate && process.platform === "win32") {
        context.skip();
      }
      const repoRoot = fs.realpathSync(tempDirs.make("openclaw-external-plugin-owners-"));
      const dependency = "@fixture/private-dep";
      const plugins = [
        ["first", "1.0.0"],
        ["second", "2.0.0"],
      ] as const;
      fs.writeFileSync(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "1.0.0",
          type: "module",
          exports: { "./plugin-sdk/probe": "./dist/plugin-sdk/probe.js" },
        }),
      );
      fs.mkdirSync(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, "dist", "plugin-sdk", "probe.js"),
        "export const shared = {};\n",
      );
      const sourceHostLinks = new Map<string, string>();
      for (const [pluginId, version] of plugins) {
        const packageDir = path.join(repoRoot, "extensions", pluginId);
        const modulesDir = path.join(packageDir, "node_modules");
        const dependencyLink = path.join(modulesDir, dependency);
        const dependencyDir = path.join(repoRoot, "installed", version, "node_modules", dependency);
        fs.mkdirSync(dependencyDir, { recursive: true });
        fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
        fs.mkdirSync(path.join(modulesDir, ".bin"));
        fs.writeFileSync(
          path.join(modulesDir, ".bin", "probe.cjs"),
          `console.log(require("../${dependency}").version);\n`,
        );
        fs.symlinkSync(
          path.relative(path.dirname(dependencyLink), dependencyDir),
          dependencyLink,
          "dir",
        );
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({
            name: `@openclaw/${pluginId}`,
            version: "1.0.0",
            type: "module",
            dependencies: { [dependency]: version },
            peerDependencies: { openclaw: "1.0.0" },
            openclaw: {
              extensions: ["./index.ts"],
              build: { bundledDist: false, runtimeFormat },
              release: { publishToNpm: true },
            },
          }),
        );
        fs.writeFileSync(
          path.join(dependencyDir, "package.json"),
          JSON.stringify({ name: dependency, version, main: "index.cjs" }),
        );
        fs.writeFileSync(
          path.join(dependencyDir, "index.cjs"),
          `exports.version = ${JSON.stringify(version)};\n`,
        );
        fs.writeFileSync(path.join(dependencyDir, "SKILL.md"), `# Private dependency ${version}\n`);
        fs.symlinkSync(
          path.relative(modulesDir, repoRoot),
          path.join(packageDir, "node_modules", "openclaw"),
          "dir",
        );
        sourceHostLinks.set(pluginId, fs.readlinkSync(path.join(modulesDir, "openclaw")));
        fs.writeFileSync(
          path.join(packageDir, "index.ts"),
          `export { version } from "${dependency}";\nexport { shared } from "openclaw/plugin-sdk/probe";\n`,
        );
        fs.writeFileSync(
          path.join(packageDir, "openclaw.plugin.json"),
          JSON.stringify({ id: pluginId, skills: [`./node_modules/${dependency}`] }),
        );
      }
      await buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" });
      // Start with the previous build's directory link, then exercise both profile transitions.
      for (const [pluginId] of plugins) {
        fs.symlinkSync(
          path.join(repoRoot, "extensions", pluginId, "node_modules"),
          path.join(repoRoot, "dist", "extensions", pluginId, "node_modules"),
          "junction",
        );
      }
      // Old output links belong to the previous profile, even when the new plan is unified.
      for (const [profile, env, isolated] of [
        [
          "legacy Docker unified",
          { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "first,second" },
          false,
        ],
        ["isolated", {}, true],
        ["Docker unified", { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "first,second" }, false],
        ["isolated again", {}, true],
        ["isolated repeated", {}, true],
      ] as const) {
        copyBundledPluginMetadata({ repoRoot, env });
        for (const [pluginId, version] of plugins) {
          const sourceModules = path.join(repoRoot, "extensions", pluginId, "node_modules");
          const outputRoot = path.join(repoRoot, "dist", "extensions", pluginId);
          expect(
            fs.readFileSync(path.join(sourceModules, dependency, "SKILL.md"), "utf8"),
            profile,
          ).toBe(`# Private dependency ${version}\n`);
          expect(fs.existsSync(path.join(outputRoot, "node_modules", "openclaw")), profile).toBe(
            isolated,
          );
          expect(fs.readlinkSync(path.join(sourceModules, "openclaw")), profile).toBe(
            sourceHostLinks.get(pluginId),
          );
          const manifest = JSON.parse(
            fs.readFileSync(path.join(outputRoot, "openclaw.plugin.json"), "utf8"),
          );
          expect(manifest.skills, profile).toEqual([`./bundled-skills/${dependency}`]);
          expect(
            fs.readFileSync(path.join(outputRoot, manifest.skills[0], "SKILL.md"), "utf8"),
            profile,
          ).toBe(`# Private dependency ${version}\n`);
        }
      }
      let runtimeRoot = repoRoot;
      if (relocate) {
        runtimeRoot = fs.realpathSync(tempDirs.make("openclaw-external-plugin-relocated-"));
        await fs.promises.cp(repoRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
        fs.rmSync(repoRoot, { recursive: true });
      }
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const entryUrl = (pluginId: string) =>
        pathToFileURL(path.join(runtimeRoot, "dist", "extensions", pluginId, `index${extension}`))
          .href;
      const stagedDir = path.join(runtimeRoot, "staged", "first");
      // Moving only a plugin needs POSIX links rebased to their source owners;
      // moving the whole checkout above preserves them. Keep Windows junctions
      // verbatim and use async cp: cpSync can recurse through the host back-link.
      await fs.promises.cp(path.join(runtimeRoot, "dist", "extensions", "first"), stagedDir, {
        recursive: true,
        verbatimSymlinks: process.platform === "win32",
      });
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      const load = ${runtimeFormat === "cjs" ? "(url) => createRequire(import.meta.url)(fileURLToPath(url))" : "(url) => import(url)"};
      const first = await load(${JSON.stringify(entryUrl("first"))});
      const second = await load(${JSON.stringify(entryUrl("second"))});
      const staged = await load(${JSON.stringify(pathToFileURL(path.join(stagedDir, `index${extension}`)).href)});
      const host = await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot, "dist/plugin-sdk/probe.js")).href)});
      console.log(JSON.stringify({ versions: [first.version, second.version, staged.version], shared: first.shared === host.shared && first.shared === second.shared && first.shared === staged.shared }));
    `,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({ versions: ["1.0.0", "2.0.0", "1.0.0"], shared: true });
      for (const [pluginId, version] of plugins) {
        const modules = path.join(runtimeRoot, "dist", "extensions", pluginId, "node_modules");
        expect(fs.lstatSync(modules).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(modules, "@fixture")).isSymbolicLink()).toBe(false);
        for (const [name, owner] of [
          ["openclaw", runtimeRoot],
          [dependency, path.join(runtimeRoot, "installed", version, "node_modules", dependency)],
          [".bin", path.join(runtimeRoot, "extensions", pluginId, "node_modules", ".bin")],
        ] as const) {
          const link = path.join(modules, name);
          if (process.platform !== "win32") {
            expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false);
          }
          expect(fs.realpathSync(link)).toBe(owner);
        }
      }
      expect(
        execFileSync(process.execPath, [path.join(stagedDir, "node_modules/.bin/probe.cjs")], {
          encoding: "utf8",
        }).trim(),
      ).toBe("1.0.0");
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

  it("retains released optional outputs and respects private QA and bounded selectors", () => {
    const env = { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" };
    const selected = collectSourceCheckoutPluginBuildEntries({ env });
    expect(selected.some(({ id }) => id === "qa-lab")).toBe(false);
    expect(selected.find(({ id }) => id === "msteams")).toMatchObject({
      isolated: true,
      runtimeExtension: ".cjs",
    });
    const privateQa = collectSourceCheckoutPluginBuildEntries({
      env: { ...env, OPENCLAW_BUILD_PRIVATE_QA: "1" },
    });
    expect(privateQa.find(({ id }) => id === "qa-lab")).toMatchObject({
      isolated: false,
      runtimeExtension: ".js",
    });
    expect(
      collectSourceCheckoutPluginBuildEntries({
        env: { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "telegram" },
      }).map(({ id }) => id),
    ).toEqual(["telegram"]);
  });

  it("agrees on Docker compiler, metadata, and readiness outputs without unselected excluded plugins", () => {
    const repoRoot = fs.realpathSync(tempDirs.make("openclaw-docker-plugin-format-"));
    const pluginIds = ["demo", "unselected", "packaged"];
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        type: "module",
        files: ["dist/**", "!dist/extensions/demo/**", "!dist/extensions/unselected/**"],
      }),
    );
    for (const id of pluginIds) {
      const pluginRoot = path.join(repoRoot, "extensions", id);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({ id }));
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          openclaw: {
            extensions: ["./index.ts"],
            setupEntry: "./setup-entry.ts",
            build: { bundledDist: id !== "demo", runtimeFormat: "cjs" },
            release: { publishToNpm: true },
          },
        }),
      );
      for (const entry of ["index.ts", "setup-entry.ts"]) {
        fs.writeFileSync(path.join(pluginRoot, entry), "export {};\n");
      }
    }
    // Evaluate the real compiler config against synthetic plugins. These links
    // expose existing read-only config inputs; no core graph is compiled.
    for (const input of [
      "packages",
      "src",
      "node_modules",
      "extensions/browser",
      "extensions/anthropic",
    ]) {
      fs.symlinkSync(path.resolve(input), path.join(repoRoot, input), "dir");
    }
    const env = { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "demo" };
    const compiler = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `
        import { pathToFileURL } from "node:url";
        const { default: configs } = await import(pathToFileURL(process.argv[1]).href);
        const entry = configs.find((config) => config.name === "openclaw-unified").entry;
        const ids = new Set(JSON.parse(process.argv[2]));
        console.log(JSON.stringify(Object.keys(entry).filter((key) =>
          key.startsWith("extensions/") && ids.has(key.split("/")[1])).sort()));
      `,
        path.resolve("tsdown.config.ts"),
        JSON.stringify(pluginIds),
      ],
      { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8" },
    );
    expect(compiler.status, compiler.stderr).toBe(0);
    const compilerEntries: string[] = JSON.parse(compiler.stdout);
    expect(compilerEntries).toEqual([
      "extensions/demo/index",
      "extensions/demo/setup-entry",
      "extensions/packaged/index",
      "extensions/packaged/setup-entry",
    ]);
    const distRoot = path.join(repoRoot, "dist");
    for (const entry of compilerEntries) {
      const output = path.join(distRoot, `${entry}.js`);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "export {};\n");
    }
    copyBundledPluginMetadata({ repoRoot, env });
    const builtPackage = JSON.parse(
      fs.readFileSync(path.join(distRoot, "extensions/demo/package.json"), "utf8"),
    );
    expect(builtPackage.openclaw.extensions).toEqual(["./index.js"]);
    expect(builtPackage.openclaw.setupEntry).toBe("./setup-entry.js");
    expect(fs.existsSync(path.join(distRoot, "extensions/unselected"))).toBe(false);
    expect(listExternalPluginLocalDistPackageDirs({ repoRoot, env })).toEqual([]);
    const distEntry = path.join(distRoot, "entry.js");
    const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
    fs.writeFileSync(distEntry, "export {};\n");
    fs.writeFileSync(buildStampPath, "{}\n");
    expect(
      resolveBuildRequirement({
        cwd: repoRoot,
        env,
        fs,
        distRoot,
        distEntry,
        buildStampPath,
        configFiles: [],
        sourceRoots: [],
        spawnSync: () => ({ status: 1 }),
      }),
    ).toEqual({ shouldBuild: false, reason: "clean" });
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
