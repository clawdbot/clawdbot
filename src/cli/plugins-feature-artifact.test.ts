import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { extract } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validatePackageExtensionEntriesForInstall,
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
} from "../plugins/package-entry-resolution.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getCachedPluginSourceModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { defaultRuntime } from "../runtime.js";
import {
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
} from "./plugins-authoring-command.js";
import {
  createPluginImportFixture,
  unresolvedPluginImportCases,
} from "./plugins-build-bundle.test-support.js";
import { runPluginsPackCommand } from "./plugins-feature-artifact.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feature-pack-"));
  directories.push(parent);
  const rootDir = path.join(parent, "draft-review");
  await runPluginsInitCommand("draft-review", { directory: rootDir, type: "feature" });
  await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "dir");
  await build({
    absWorkingDir: rootDir,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["openclaw/*"],
    logLevel: "silent",
  });
  await fs.writeFile(
    path.join(rootDir, "dist/name.cjs"),
    'module.exports = require("node:path").basename("/fixtures/Draft Review");',
  );
  await fs.appendFile(
    path.join(rootDir, "dist/index.js"),
    '\nimport label from "./name.cjs"; if (label !== "Draft Review") throw new Error("CommonJS dependency failed");\n' +
      'const __dirname = "local"; const resourceNames = { __filename: "import.meta.url" }; if (__dirname !== "local" || !resourceNames.__filename) throw new Error("Local resource names failed");\n',
  );
  await runPluginsBuildCommand({ root: rootDir });
  return { rootDir, parent };
}

describe("plugin artifact authoring", () => {
  it("packs CommonJS dependencies into a self-contained artifact bound to its exact digest", async () => {
    const { rootDir, parent } = await fixture();
    await fs.appendFile(
      path.join(rootDir, "dist/index.js"),
      '\nexport const __openclawCreateRequire = 1; export const createRequire = "author"; export const require = (name) => "local:" + name; export const globalThis = "author-global";\n' +
        'if (__openclawCreateRequire !== 1 || createRequire !== "author" || require("value") !== "local:value" || globalThis !== "author-global") throw new Error("Author bindings changed");\n',
    );
    await fs.appendFile(
      path.join(rootDir, "dist/name.cjs"),
      '\nif (typeof require("openclaw/plugin-sdk/feature-plugin").defineFeaturePlugin !== "function") throw new Error("CommonJS SDK dependency failed");\n',
    );
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const archive = path.join(await fs.realpath(rootDir), "draft-review.tgz");
    await runPluginsPackCommand({ root: rootDir, json: true });
    const bytes = await fs.readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({
      path: archive,
      sha256,
      pluginId: "draft-review",
      bytes: bytes.length,
      activation: { action: "plugin_activate_artifact", path: archive, sha256 },
    });
    const extracted = path.join(parent, "extracted");
    await fs.mkdir(extracted);
    await extract({ file: archive, cwd: extracted, strict: true });
    const packageRoot = path.join(extracted, "package");
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    expect(metadata.dependencies).toBeUndefined();
    expect(metadata.scripts).toBeUndefined();
    expect(metadata.openclaw.controlUi).toBeUndefined();
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "openclaw.plugin.json"), "utf8"),
    );
    expect(await fs.readFile(path.join(packageRoot, manifest.controlUi.entry), "utf8")).toContain(
      "Draft composer",
    );
    const loaded = await loadToolPlugin({
      rootDir: packageRoot,
      entryPath: path.join(packageRoot, "dist/index.js"),
    });
    expect(loaded.metadata.id).toBe("draft-review");
    expect(loaded.metadata.tools.map((tool) => tool.name)).toEqual(["draft_review_analyze"]);
    const sourceExtracted = path.join(parent, "source-extracted");
    await fs.mkdir(sourceExtracted);
    await extract({ file: archive, cwd: sourceExtracted, strict: true });
    const sourcePackageRoot = path.join(sourceExtracted, "package");
    const sourceEntryPath = path.join(sourcePackageRoot, "dist/index.js");
    // A separate extraction keeps Node's module cache from masking the source
    // loader's SDK aliases, even when the host also has built SDK artifacts.
    const sourceLoaded = withPluginCache(createPluginCache(), () =>
      getCachedPluginSourceModuleLoader({
        modulePath: sourceEntryPath,
        rootDir: sourcePackageRoot,
        importerUrl: import.meta.url,
        aliasMap: buildPluginLoaderAliasMap(
          sourceEntryPath,
          process.argv[1],
          import.meta.url,
          "src",
        ),
        transformOpenClawDependencies: true,
      })(sourceEntryPath),
    );
    expect(sourceLoaded).toMatchObject({
      __openclawCreateRequire: 1,
      createRequire: "author",
      globalThis: "author-global",
      default: { id: "draft-review" },
    });
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    expect(await fs.readFile(archive)).toEqual(bytes);
  });

  it.each([
    {
      id: "inferred-tools",
      filename: "inferred-tools.tgz",
      runtime: false,
      inferred: true,
      setup: true,
    },
    { id: "@author/tools", filename: "@author__tools.tgz", runtime: false, setup: false },
    { id: "runtime-tools", filename: "runtime-tools.tgz", runtime: true, setup: false },
    { id: "setup-tools", filename: "setup-tools.tgz", runtime: true, setup: true },
  ])(
    "packs $id with its installed runtime and metadata intact",
    async ({ id, filename, runtime, setup, inferred = false }) => {
      const parent = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-pack-")),
      );
      directories.push(parent);
      const rootDir = path.join(parent, "project");
      await fs.mkdir(path.join(rootDir, "dist"), { recursive: true });
      await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "dir");
      const packageManifest = {
        name: id,
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: [inferred ? "./src/index.ts" : "./dist/index.js"],
          ...(runtime ? { runtimeExtensions: ["./dist/compiled.js"] } : {}),
          ...(setup
            ? {
                setupEntry: "./dist/setup-source.js",
                ...(runtime ? { runtimeSetupEntry: "./dist/setup-runtime.js" } : {}),
              }
            : {}),
          compat: { pluginApi: ">=2026.5.17" },
        },
      };
      await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify(packageManifest));
      await fs.writeFile(
        path.join(rootDir, "dist/shared.js"),
        "export const shared = { ready: false };",
      );
      const entry = (
        marker: string,
        sharedPath = "./shared.js",
      ) => `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { shared } from ${JSON.stringify(sharedPath)}; shared.ready = true;
export default Object.assign(defineToolPlugin({ id: ${JSON.stringify(id)}, name: "Packed tool", description: "Artifact fixture", tools: (tool) => [tool({ name: "artifact_echo", description: "Echo", optional: true, parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) })] }), { artifactMarker: ${JSON.stringify(marker)}, shared });`;
      await fs.writeFile(
        path.join(rootDir, "dist/index.js"),
        entry(inferred ? "runtime" : "source"),
      );
      if (inferred) {
        await fs.mkdir(path.join(rootDir, "src"));
        await fs.writeFile(
          path.join(rootDir, "src/index.ts"),
          entry("source", "../dist/shared.js"),
        );
      }
      if (runtime) {
        await fs.writeFile(path.join(rootDir, "dist/compiled.js"), entry("runtime"));
      }
      if (setup) {
        await fs.writeFile(
          path.join(rootDir, "dist/setup-source.js"),
          'import { shared } from "./shared.js"; export default { artifactMarker: "setup-source", shared };',
        );
        await fs.writeFile(
          path.join(rootDir, "dist/setup-runtime.js"),
          'import { shared } from "./shared.js"; export default { artifactMarker: "setup-runtime", shared };',
        );
      }
      await runPluginsBuildCommand({ root: rootDir });
      const sourceManifest = await fs.readFile(path.join(rootDir, "openclaw.plugin.json"));
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      await runPluginsPackCommand({ root: rootDir, json: true });
      const archive = path.join(rootDir, filename);
      expect(writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: id, path: archive }),
      );
      const extracted = path.join(parent, "extracted");
      await fs.mkdir(extracted);
      await extract({ file: archive, cwd: extracted, strict: true });
      const packageDir = path.join(extracted, "package");
      const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
      expect(await fs.readFile(path.join(packageDir, "openclaw.plugin.json"))).toEqual(
        sourceManifest,
      );
      expect(manifest.openclaw.compat).toEqual(packageManifest.openclaw.compat);
      expect(
        await validatePackageExtensionEntriesForInstall({
          packageDir,
          manifest,
          extensions: manifest.openclaw.extensions,
        }),
      ).toEqual({ ok: true });
      const resolution = {
        packageDir,
        manifest,
        origin: "global" as const,
        sourceLabel: packageDir,
        diagnostics: [],
      };
      const [entryPath] = resolvePackageRuntimeExtensionSources({
        ...resolution,
        extensions: manifest.openclaw.extensions,
      });
      const loaded = await loadToolPlugin({ rootDir: packageDir, entryPath: entryPath! });
      expect(loaded.entry).toMatchObject({
        artifactMarker: runtime || inferred ? "runtime" : "source",
      });
      expect(loaded.metadata).toMatchObject({
        id,
        tools: [{ name: "artifact_echo", optional: true }],
      });
      if (setup) {
        // Keep native module caches out of the independent source-loader graph.
        const sourceExtracted = path.join(parent, "source-extracted");
        await fs.mkdir(sourceExtracted);
        await extract({ file: archive, cwd: sourceExtracted, strict: true });
        const sourcePackageDir = path.join(sourceExtracted, "package");
        const sourceResolution = {
          ...resolution,
          packageDir: sourcePackageDir,
          sourceLabel: sourcePackageDir,
        };
        const [sourceEntryPath] = resolvePackageRuntimeExtensionSources({
          ...sourceResolution,
          extensions: manifest.openclaw.extensions,
        });
        const setupPath = resolvePackageSetupSource(sourceResolution);
        expect(setupPath).toBeTruthy();
        withPluginCache(createPluginCache(), () => {
          const load = getCachedPluginSourceModuleLoader({
            modulePath: sourceEntryPath!,
            rootDir: sourcePackageDir,
            importerUrl: import.meta.url,
            aliasMap: buildPluginLoaderAliasMap(
              sourceEntryPath!,
              process.argv[1],
              import.meta.url,
              "src",
            ),
            transformOpenClawDependencies: true,
          });
          expect(load(sourceEntryPath!)).toMatchObject({ default: { shared: { ready: true } } });
          expect(load(setupPath!)).toMatchObject({
            default: {
              artifactMarker: runtime ? "setup-runtime" : "setup-source",
              shared: { ready: true },
            },
          });
        });
      }
      const files = await fs.readdir(path.join(packageDir, "dist"));
      expect(files.filter((file) => !file.startsWith("chunk-")).toSorted()).toEqual(
        setup ? ["index.js", "setup.js"] : ["index.js"],
      );
      expect(files.filter((file) => file.startsWith("chunk-"))).toHaveLength(setup ? 1 : 0);
    },
  );

  it("rejects opaque prebundles with guidance to use the regular package-install flow", async () => {
    const { rootDir, parent } = await fixture();
    const result = await build({
      absWorkingDir: rootDir,
      entryPoints: ["dist/index.js"],
      outfile: "dist/prebundled.js",
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["openclaw/*"],
      write: false,
      logLevel: "silent",
    });
    await fs.writeFile(path.join(rootDir, "dist/index.js"), result.outputFiles[0]!.contents);
    const archive = path.join(parent, "prebundled.tgz");
    await expect(runPluginsPackCommand({ root: rootDir, out: archive })).rejects.toThrow(
      /Indirect calls to "require" will not be bundled[\s\S]*regular package-install flow/u,
    );
    await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(unresolvedPluginImportCases)(
    "rejects unresolved $name before producing an artifact",
    async (testCase) => {
      const {
        file,
        expected = "required dependency",
        diagnostic = "will not be bundled",
      } = testCase;
      const { rootDir, parent } = await fixture();
      const runOriginal = await createPluginImportFixture(
        path.join(rootDir, "dist/runtime"),
        testCase,
      );
      await fs.appendFile(
        path.join(rootDir, "dist/index.js"),
        `\nexport { loadDependency } from "./runtime/${file}";\n`,
      );
      expect(runOriginal()).toBe(expected);
      const archive = path.join(parent, "runtime-dependency.tgz");
      await expect(runPluginsPackCommand({ root: rootDir, out: archive })).rejects.toThrow(
        diagnostic,
      );
      await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves prebuilt browser dependencies without packing unrelated files", async () => {
    const { rootDir, parent } = await fixture();
    const packagePath = path.join(rootDir, "package.json");
    const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
    delete metadata.openclaw.controlUi;
    await fs.writeFile(packagePath, JSON.stringify(metadata));
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const directory = "dist/control-ui/prebuilt";
    manifest.controlUi = {
      entry: `${directory}/index.js`,
      styles: [`${directory}/theme.css`],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const files = {
      "index.js":
        'import { prefix } from "./chunks/shared.mjs"; export default { id: "draft-review", async activate() { return prefix + (await import("./chunks/lazy.js")).suffix; } };',
      "chunks/shared.mjs": 'export const prefix = "Prebuilt ";',
      "chunks/lazy.js": 'export const suffix = "ready";',
      "theme.css": '@import "./styles/palette.css"; .prebuilt { color: var(--accent); }',
      "styles/palette.css": ":root { --accent: red; }",
      "index.js.map": "private sourcemap",
      "source.ts": "private source",
      ".hidden.js": "private hidden file",
    };
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(rootDir, directory, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    const activate = async (packageRoot: string) => {
      const browser = await import(
        pathToFileURL(path.join(packageRoot, manifest.controlUi.entry)).href
      );
      return browser.default.activate();
    };
    expect(await activate(rootDir)).toBe("Prebuilt ready");

    const archive = path.join(parent, "prebuilt.tgz");
    await runPluginsPackCommand({ root: rootDir, out: archive });
    const extracted = path.join(parent, "extracted");
    await fs.mkdir(extracted);
    await extract({ file: archive, cwd: extracted, strict: true });
    const packageRoot = path.join(extracted, "package");
    expect(await activate(packageRoot)).toBe("Prebuilt ready");
    expect(await fs.readFile(path.join(packageRoot, directory, "theme.css"), "utf8")).toBe(
      files["theme.css"],
    );
    expect(await fs.readFile(path.join(packageRoot, directory, "styles/palette.css"), "utf8")).toBe(
      files["styles/palette.css"],
    );
    for (const name of ["index.js.map", "source.ts", ".hidden.js"]) {
      await expect(fs.stat(path.join(packageRoot, directory, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it.each([
    {
      name: "ES module URL",
      file: "resource.mjs",
      source:
        'import { readFileSync } from "node:fs"; export const resource = readFileSync(new URL("./template.txt", import.meta.url), "utf8");',
    },
    {
      name: "CommonJS directory",
      file: "resource.cjs",
      source:
        'exports.resource = require("node:fs").readFileSync(require("node:path").join(__dirname, "template.txt"), "utf8");',
    },
    {
      name: "CommonJS filename",
      file: "resource.cjs",
      source:
        'exports.resource = require("node:fs").readFileSync(require("node:path").join(require("node:path").dirname(__filename), "template.txt"), "utf8");',
    },
  ])(
    "rejects backend resources located by $name before producing an artifact",
    async ({ file, source }) => {
      const { rootDir, parent } = await fixture();
      const resources = path.join(rootDir, "dist/runtime");
      await fs.mkdir(resources);
      await fs.writeFile(path.join(resources, "template.txt"), "required template");
      await fs.writeFile(path.join(resources, file), source);
      await fs.appendFile(
        path.join(rootDir, "dist/index.js"),
        `\nimport { resource } from "./runtime/${file}"; if (resource !== "required template") throw new Error("Backend resource failed");\n`,
      );
      const loaded = await loadToolPlugin({
        rootDir,
        entryPath: path.join(rootDir, "dist/index.js"),
      });
      expect(loaded.metadata.id).toBe("draft-review");
      const archive = path.join(parent, "runtime-resource.tgz");
      await expect(runPluginsPackCommand({ root: rootDir, out: archive })).rejects.toThrow(
        "module-relative runtime files",
      );
      await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects stale browser source and never overwrites an existing approval artifact", async () => {
    const { rootDir, parent } = await fixture();
    const out = path.join(parent, "review.tgz");
    await fs.writeFile(out, "existing review");
    await expect(runPluginsPackCommand({ root: rootDir, out })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(out, "utf8")).toBe("existing review");
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    await expect(runPluginsPackCommand({ root: rootDir })).rejects.toThrow("missing or stale");
    await expect(fs.stat(path.join(rootDir, "draft-review.tgz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
