// Runtime Postbuild tests cover runtime postbuild script behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsForPackage,
  copyStaticExtensionAssetsToRuntimeOverlay,
  discoverStaticExtensionAssets,
} from "../../scripts/lib/static-extension-assets.mts";
import {
  rewriteRootRuntimeImportsToStableAliases,
  runRuntimePostBuild,
  writeLegacyCliExitCompatChunks,
  writeLegacyRootRuntimeCompatAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  expect(statError).toBeInstanceOf(Error);
  if (!(statError instanceof Error)) {
    throw new Error("expected missing path error");
  }
  expect(Reflect.get(statError, "code")).toBe("ENOENT");
}

async function writeExportHtmlBuildFixture(rootDir: string): Promise<void> {
  const sourceDir = path.join(rootDir, "src", "auto-reply", "reply", "export-html");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "template.html"), "<html></html>\n", "utf8");
  await fs.writeFile(path.join(rootDir, "package.json"), "{}\n", "utf8");
  for (const fixture of [
    {
      name: "marked",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      source: 'export const parse = () => "alternate-root-marked"; export const use = () => {};\n',
      license: "ALTERNATE ROOT MARKED LICENSE\n",
    },
    {
      name: "highlight.js",
      exports: { "./lib/common": "./common.js", "./package.json": "./package.json" },
      source: 'export default { marker: "alternate-root-highlight" };\n',
      license: "ALTERNATE ROOT HIGHLIGHT LICENSE\n",
    },
  ]) {
    const packageDir = path.join(rootDir, "node_modules", fixture.name);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: fixture.name, type: "module", exports: fixture.exports })}\n`,
      "utf8",
    );
    const entryName = fixture.name === "marked" ? "index.js" : "common.js";
    await fs.writeFile(path.join(packageDir, entryName), fixture.source, "utf8");
    await fs.writeFile(path.join(packageDir, "LICENSE"), fixture.license, "utf8");
  }
}

describe("runtime postbuild static assets", () => {
  it("copies bundled hook metadata without replacing compiled handlers", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-hooks-");
    const sourceHookDir = path.join(rootDir, "src", "hooks", "bundled", "session-memory");
    const distHookDir = path.join(rootDir, "dist", "bundled", "session-memory");
    await fs.mkdir(sourceHookDir, { recursive: true });
    await fs.mkdir(distHookDir, { recursive: true });
    await fs.writeFile(path.join(sourceHookDir, "HOOK.md"), "---\nname: session-memory\n---\n");
    await fs.writeFile(path.join(distHookDir, "handler.js"), "export default () => {};\n");

    runRuntimePostBuild({
      rootDir,
      env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" },
      timings: false,
    });

    await expect(fs.readFile(path.join(distHookDir, "HOOK.md"), "utf8")).resolves.toContain(
      "name: session-memory",
    );
    await expect(fs.readFile(path.join(distHookDir, "handler.js"), "utf8")).resolves.toBe(
      "export default () => {};\n",
    );
  });

  it("discovers repo static asset metadata without scanning extension directories", () => {
    const payload = expectNoNodeFsScans<{
      outputs: string[];
      sources: string[];
      packageOutputs: string[];
    }>(`
      const assets = await import("./scripts/lib/static-extension-assets.mts");
      return {
        outputs: assets.listStaticExtensionAssetOutputs(),
        sources: assets.listStaticExtensionAssetSources(),
        packageOutputs: assets.listStaticExtensionAssetOutputs({ includeExternalPlugins: true }),
      };
    `);

    expect(payload.outputs).toEqual([
      "dist/extensions/acpx/mcp-command-line.mjs",
      "dist/extensions/acpx/mcp-proxy.mjs",
      "dist/extensions/crabbox/assets/openclaw-worker-wallpaper.png",
      "dist/extensions/onepassword/onepassword-op-path.js",
      "dist/extensions/onepassword/onepassword-secret-id.js",
      "dist/extensions/onepassword/onepassword-secret-ref-resolver.js",
      "dist/extensions/vault/vault-secret-id.js",
      "dist/extensions/vault/vault-secret-ref-resolver.js",
    ]);
    expect(payload.sources).not.toContain(
      "extensions/diffs-language-pack/assets/viewer-runtime.js",
    );
    expect(payload.sources).not.toContain("extensions/diffs/assets/viewer-runtime.js");
    expect(payload.sources).not.toContain("extensions/discord/assets/embedded-app-sdk.mjs");
    expect(payload.packageOutputs).toContain("dist/extensions/discord/assets/embedded-app-sdk.mjs");
    expect(payload.sources).toContain("extensions/crabbox/assets/openclaw-worker-wallpaper.png");
  });

  it("discovers static assets from plugin package metadata", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const packageDir = path.join(rootDir, "extensions", "demo");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/demo",
        openclaw: {
          build: {
            staticAssets: [
              {
                source: "./assets/runtime.js",
                output: "assets/runtime.js",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(discoverStaticExtensionAssets({ rootDir })).toEqual([
      {
        pluginDir: "demo",
        src: "extensions/demo/assets/runtime.js",
        dest: "dist/extensions/demo/assets/runtime.js",
      },
    ]);
  });

  it.each([
    { name: "top-level array", packageJson: [] },
    { name: "array openclaw section", packageJson: { openclaw: [] } },
    { name: "array build section", packageJson: { openclaw: { build: [] } } },
    {
      name: "non-record asset entries",
      packageJson: {
        openclaw: {
          build: {
            staticAssets: [[], "asset", null, { source: 42, output: [] }],
          },
        },
      },
    },
  ])("ignores malformed $name metadata", async ({ packageJson }) => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-malformed-");
    const packageDir = path.join(rootDir, "extensions", "demo");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify(packageJson), "utf8");

    expect(discoverStaticExtensionAssets({ rootDir })).toEqual([]);
  });

  it.each([
    { name: "normal root build", params: {}, included: false },
    { name: "isolated external build", params: { includeExternalPlugins: true }, included: true },
    {
      name: "Docker-selected build",
      params: { env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external-demo" } },
      included: true,
    },
  ])("$name handles external plugin assets", async ({ params, included }) => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const packageDir = path.join(rootDir, "extensions", "external-demo");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/external-demo",
        openclaw: {
          build: {
            bundledDist: false,
            staticAssets: [
              {
                source: "./assets/runtime.js",
                output: "assets/runtime.js",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(discoverStaticExtensionAssets({ rootDir, ...params })).toEqual(
      included
        ? [
            {
              pluginDir: "external-demo",
              src: "extensions/external-demo/assets/runtime.js",
              dest: "dist/extensions/external-demo/assets/runtime.js",
            },
          ]
        : [],
    );
  });

  it("copies declared static assets into root and package dist", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const src = "extensions/acpx/src/runtime-internals/mcp-proxy.mjs";
    const dest = "dist/extensions/acpx/mcp-proxy.mjs";
    const sourcePath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    const packageDestPath = path.join(rootDir, "extensions", "acpx", "dist", "mcp-proxy.mjs");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "proxy-data\n", "utf8");

    copyStaticExtensionAssets({
      rootDir,
      assets: [{ src, dest }],
    });
    expect(
      copyStaticExtensionAssetsForPackage({
        rootDir,
        pluginDir: "acpx",
        assets: [{ src, dest }],
      }),
    ).toEqual(["dist/mcp-proxy.mjs"]);

    expect(await fs.readFile(destPath, "utf8")).toBe("proxy-data\n");
    expect(await fs.readFile(packageDestPath, "utf8")).toBe("proxy-data\n");
  });

  it("stages copied static assets byte-for-byte during the same postbuild run", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const source = "extensions/diffs/assets/viewer-runtime.js";
    const output = "assets/viewer-runtime.js";
    const distAsset = "dist/extensions/diffs/assets/viewer-runtime.js";
    const runtimeAsset = "dist-runtime/extensions/diffs/assets/viewer-runtime.js";

    await fs.mkdir(path.join(rootDir, "extensions", "diffs", "assets"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "extensions", "diffs", "package.json"),
      JSON.stringify({
        name: "@openclaw/diffs",
        openclaw: {
          extensions: ["./index.ts"],
          build: {
            staticAssets: [{ source: `./${output}`, output }],
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "extensions", "diffs", "openclaw.plugin.json"),
      '{"id":"diffs"}\n',
      "utf8",
    );
    await fs.writeFile(path.join(rootDir, source), "export const viewer = true;\n", "utf8");

    runRuntimePostBuild({
      cwd: rootDir,
      repoRoot: rootDir,
      rootDir,
      timings: false,
    });

    await expect(fs.readFile(path.join(rootDir, distAsset), "utf8")).resolves.toBe(
      "export const viewer = true;\n",
    );
    await expect(fs.readFile(path.join(rootDir, runtimeAsset), "utf8")).resolves.toBe(
      "export const viewer = true;\n",
    );
  });

  it("writes every phase beneath the cwd-only caller root", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-cwd-");
    const sentinelDest = path.join(
      "dist",
      `runtime-postbuild-cwd-only-${path.basename(rootDir)}.js`,
    );
    const moduleSentinelPath = path.join(MODULE_ROOT, sentinelDest);
    await writeExportHtmlBuildFixture(rootDir);
    await expectPathMissing(moduleSentinelPath);

    try {
      const params = {
        chunks: [{ dest: sentinelDest, contents: "selected root only\n" }],
        cwd: rootDir,
        env: {
          OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
          OPENCLAW_CONTROL_UI_BUILD_ID: "source-runtime-build",
        },
        timings: false,
      };
      runRuntimePostBuild(params);

      expect(
        readBuildIdFromBuildInfoForModuleUrl(
          pathToFileURL(path.join(rootDir, "dist/entry.js")).href,
        ),
      ).toBe("source-runtime-build");
      await expect(
        fs.readFile(path.join(rootDir, "dist", "export-html", "template.html"), "utf8"),
      ).resolves.toBe("<html></html>\n");
      const vendorDir = path.join(rootDir, "dist", "export-html", "vendor");
      const markedAsset = await fs.readFile(path.join(vendorDir, "marked.min.js"), "utf8");
      const highlightAsset = await fs.readFile(path.join(vendorDir, "highlight.min.js"), "utf8");
      expect(markedAsset).toContain("ALTERNATE ROOT MARKED LICENSE");
      expect(markedAsset).toContain("alternate-root-marked");
      expect(highlightAsset).toContain("ALTERNATE ROOT HIGHLIGHT LICENSE");
      expect(highlightAsset).toContain("alternate-root-highlight");
      await expect(
        fs.readFile(path.join(rootDir, "dist", "channel-catalog.json"), "utf8"),
      ).resolves.toContain('"entries"');
      await expect(fs.readFile(path.join(rootDir, sentinelDest), "utf8")).resolves.toBe(
        "selected root only\n",
      );
      await expectPathMissing(moduleSentinelPath);
    } finally {
      await fs.rm(moduleSentinelPath, { force: true });
    }
  });

  it("uses rootDir ahead of conflicting cwd and repoRoot for every phase", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-root-");
    const cwd = createTempDir("openclaw-runtime-postbuild-rejected-cwd-");
    const repoRoot = createTempDir("openclaw-runtime-postbuild-rejected-repo-");
    await writeExportHtmlBuildFixture(rootDir);

    runRuntimePostBuild({
      cwd,
      env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" },
      repoRoot,
      rootDir,
      timings: false,
    });

    await expect(
      fs.readFile(path.join(rootDir, "dist", "export-html", "template.html"), "utf8"),
    ).resolves.toBe("<html></html>\n");
    await expect(
      fs.readFile(path.join(rootDir, "dist", "channel-catalog.json"), "utf8"),
    ).resolves.toContain('"entries"');
    await expect(
      fs.readFile(path.join(rootDir, "dist", "memory-state-CcqRgDZU.js"), "utf8"),
    ).resolves.toContain("hasMemoryRuntime");
    await expectPathMissing(path.join(cwd, "dist"));
    await expectPathMissing(path.join(repoRoot, "dist"));
  });

  it("validates every postbuild root before running any phase", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-roots-");
    const distFile = path.join(rootDir, "dist", "keep.js");
    const targetDir = path.join(rootDir, "gateway-runtime");
    await fs.mkdir(path.dirname(distFile), { recursive: true });
    await fs.mkdir(targetDir);
    await fs.writeFile(distFile, "keep\n");
    await fs.symlink(targetDir, path.join(rootDir, "dist-runtime"), "dir");

    expect(() =>
      runRuntimePostBuild({
        cwd: rootDir,
        repoRoot: rootDir,
        rootDir,
        timings: false,
      }),
    ).toThrow(/symbolic link/u);

    await expect(fs.readdir(path.join(rootDir, "dist"))).resolves.toEqual(["keep.js"]);
    await expect(fs.readFile(distFile, "utf8")).resolves.toBe("keep\n");
  });

  it("preserves restored dist static assets when plugin sources are absent", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const output = "assets/viewer-runtime.js";
    const distPluginDir = path.join(rootDir, "dist", "extensions", "diffs");
    const runtimeAsset = path.join(rootDir, "dist-runtime", "extensions", "diffs", output);

    await fs.mkdir(path.join(distPluginDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(distPluginDir, "index.js"), "export default {};\n", "utf8");
    await fs.writeFile(
      path.join(distPluginDir, "openclaw.plugin.json"),
      '{"id":"diffs"}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distPluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/diffs",
        openclaw: {
          extensions: ["./index.js"],
          build: {
            staticAssets: [{ source: `./${output}`, output }],
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(distPluginDir, output), "console.log('viewer');\n", "utf8");

    runRuntimePostBuild({
      cwd: rootDir,
      repoRoot: rootDir,
      rootDir,
      timings: false,
    });

    await expect(fs.readFile(runtimeAsset, "utf8")).resolves.toBe("console.log('viewer');\n");
  });

  it("can skip static asset copies for minimal runtime builds", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const warn = vi.fn();
    const output = "assets/viewer-runtime.js";

    await fs.mkdir(path.join(rootDir, "extensions", "diffs"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "extensions", "diffs", "package.json"),
      JSON.stringify({
        name: "@openclaw/diffs",
        openclaw: {
          extensions: ["./index.ts"],
          build: {
            staticAssets: [{ source: `./${output}`, output }],
          },
        },
      }),
      "utf8",
    );

    runRuntimePostBuild({
      cwd: rootDir,
      repoRoot: rootDir,
      rootDir,
      env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" },
      timings: false,
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
    await expectPathMissing(path.join(rootDir, "dist", "extensions", "diffs", output));
  });

  it("skips runtime overlay asset copies when the runtime extension root is absent", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    await fs.mkdir(path.join(rootDir, "extensions", "demo", "assets"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "extensions", "demo", "assets", "viewer.js"),
      "viewer\n",
      "utf8",
    );

    copyStaticExtensionAssetsToRuntimeOverlay({
      rootDir,
      assets: [
        {
          src: "extensions/demo/assets/viewer.js",
          dest: "dist/extensions/demo/assets/viewer.js",
        },
      ],
    });

    await expectPathMissing(path.join(rootDir, "dist-runtime", "extensions", "demo", "assets"));
  });

  it("ignores runtime overlay static assets outside dist extensions", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    await fs.mkdir(path.join(rootDir, "dist-runtime", "extensions"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "extensions", "demo", "assets"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "extensions", "demo", "assets", "viewer.js"),
      "viewer\n",
      "utf8",
    );

    copyStaticExtensionAssetsToRuntimeOverlay({
      rootDir,
      assets: [
        {
          src: "extensions/demo/assets/viewer.js",
          dest: "dist/other/demo/assets/viewer.js",
        },
      ],
    });

    await expectPathMissing(path.join(rootDir, "dist-runtime", "other", "demo", "assets"));
  });

  it("warns when a runtime overlay static asset source is missing", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const warn = vi.fn();
    await fs.mkdir(path.join(rootDir, "dist-runtime", "extensions"), { recursive: true });

    copyStaticExtensionAssetsToRuntimeOverlay({
      rootDir,
      assets: [
        {
          src: "extensions/demo/assets/missing.js",
          dest: "dist/extensions/demo/assets/missing.js",
        },
      ],
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[runtime-postbuild] static asset not found, skipping: extensions/demo/assets/missing.js",
    );
    await expectPathMissing(
      path.join(rootDir, "dist-runtime", "extensions", "demo", "assets", "missing.js"),
    );
  });

  it("warns when a declared static asset is missing", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const warn = vi.fn();

    copyStaticExtensionAssets({
      rootDir,
      assets: [{ src: "missing/file.mjs", dest: "dist/file.mjs" }],
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[runtime-postbuild] static asset not found, skipping: missing/file.mjs",
    );
  });

  it("writes stable aliases for hashed root runtime modules", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-XyZ987.js"),
      "export const auth = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-tts.runtime-AbCd1234.js"),
      "export const tts = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "library-Other123.js"),
      "export const x = true;\n",
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-model-auth.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-model-auth.runtime-XyZ987.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "runtime-tts.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-tts.runtime-AbCd1234.js";\n',
    );
    await expectPathMissing(path.join(distDir, "library.js"));
  });

  it("refuses to rewrite stable aliases through a symlinked dist root", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    await fs.mkdir(targetDir, { recursive: true });
    const hashedFile = path.join(targetDir, "runtime-model-auth.runtime-XyZ987.js");
    await fs.writeFile(hashedFile, "export const auth = true;\n", "utf8");
    const distLink = path.join(rootDir, "dist");
    await fs.symlink(targetDir, distLink, "dir");

    expect(() => writeStableRootRuntimeAliases({ rootDir })).toThrow(/symbolic link/u);

    expect(await fs.readlink(distLink)).toBe(targetDir);
    expect(await fs.readFile(hashedFile, "utf8")).toBe("export const auth = true;\n");
    await expectPathMissing(path.join(targetDir, "runtime-model-auth.runtime.js"));
  });

  it("forwards default exports through stable and legacy aliases", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "package.json"), '{"type":"module"}\n', "utf8");
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-Hash111.js"),
      "function reconcile(value) { return value; }\nexport { reconcile as default };\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "mixed.runtime-Hash222.js"),
      "export const named = true;\nexport default function run() {}\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "named-only.runtime-Hash333.js"),
      'const marker = "export { marker as default }";\nexport { marker };\n',
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });
    writeLegacyRootRuntimeCompatAliases({ rootDir });

    const stable = await import(
      pathToFileURL(path.join(distDir, "runtime-plugins.runtime.js")).href
    );
    const legacy = await import(
      pathToFileURL(path.join(distDir, "runtime-plugins.runtime-fLHuT7Vs.js")).href
    );
    const mixed = await import(pathToFileURL(path.join(distDir, "mixed.runtime.js")).href);
    const namedOnly = await import(pathToFileURL(path.join(distDir, "named-only.runtime.js")).href);

    expect(stable.default("stable")).toBe("stable");
    expect(legacy.default("legacy")).toBe("legacy");
    expect(mixed.default).toBeTypeOf("function");
    expect(namedOnly).not.toHaveProperty("default");

    writeStableRootRuntimeAliases({ rootDir });
    writeLegacyRootRuntimeCompatAliases({ rootDir });

    const stableAfterRerun = await import(
      `${pathToFileURL(path.join(distDir, "runtime-plugins.runtime.js")).href}?rerun=1`
    );
    expect(stableAfterRerun.default("rerun")).toBe("rerun");
  });

  it("does not write ambiguous stable aliases for colliding root runtime chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      "export const pluginInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime.js"),
      'export * from "./install.runtime-Stale.js";\n',
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    await expectPathMissing(path.join(distDir, "install.runtime.js"));
  });

  it("writes a stable plugin install runtime alias when install runtimes collide", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      [
        "export const scanPackageInstallSource = true;",
        "export const scanFileInstallSource = true;",
        "export const scanInstalledPackageDependencyTree = true;",
        "export const scanBundleInstallSource = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "install.runtime.js"), "utf8")).toBe(
      'export * from "./install.runtime-Aaa111.js";\n',
    );
  });

  it("keeps stable aliases when one colliding root runtime chunk re-exports the implementation", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-Impl123.js"),
      "export const auth = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-model-auth.runtime-Wrap456.js"),
      'import { auth } from "./runtime-model-auth.runtime-Impl123.js";\nexport { auth };\n',
      "utf8",
    );

    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-model-auth.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-model-auth.runtime-Wrap456.js";\n',
    );
  });

  it("ignores legacy wrappers to the stable runtime alias when choosing the implementation", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-NewHash.js"),
      "export const ready = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-OldHash.js"),
      'export * from "./runtime-plugins.runtime.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "dispatch-OldHash.js"),
      ['const lazy = () => import("./runtime-plugins.runtime-NewHash.js");', ""].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "dispatch-OldHash.js"), "utf8")).toBe(
      ['const lazy = () => import("./runtime-plugins.runtime.js");', ""].join("\n"),
    );
    expect(await fs.readFile(path.join(distDir, "runtime-plugins.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-plugins.runtime-NewHash.js";\n',
    );
  });

  it("rewrites root runtime imports to stable aliases", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-AbCd1234.js"),
      "export const ready = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "dispatch-OldHash.js"),
      [
        'const lazy = () => import("./runtime-plugins.runtime-AbCd1234.js");',
        'import "./missing.runtime-Nope.js";',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "dispatch-OldHash.js"), "utf8")).toBe(
      [
        'const lazy = () => import("./runtime-plugins.runtime.js");',
        'import "./missing.runtime-Nope.js";',
        "",
      ].join("\n"),
    );
  });

  it("keeps text-transform runtime imports hashed after the stable alias export surface grew", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "text-transforms.runtime-NewHash.js"),
      "export const n = true;\nexport const t = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "provider-runtime-NewHash.js"),
      [
        'import { n as applyPluginTextReplacements } from "./text-transforms.runtime-NewHash.js";',
        "export { applyPluginTextReplacements };",
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    writeStableRootRuntimeAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "provider-runtime-NewHash.js"), "utf8")).toBe(
      [
        'import { n as applyPluginTextReplacements } from "./text-transforms.runtime-NewHash.js";',
        "export { applyPluginTextReplacements };",
        "",
      ].join("\n"),
    );
    expect(await fs.readFile(path.join(distDir, "text-transforms.runtime.js"), "utf8")).toBe(
      'export * from "./text-transforms.runtime-NewHash.js";\n',
    );
  });

  it("rewrites gateway shutdown imports to stable runtime aliases", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "server-close.runtime-AbCd1234.js"),
      "export const close = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "server.impl-OldHash.js"),
      [
        'const closeModule = () => import("./server-close.runtime-AbCd1234.js");',
        'const ordinaryChunk = () => import("./server-close-OldHash.js");',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "server.impl-OldHash.js"), "utf8")).toBe(
      [
        'const closeModule = () => import("./server-close.runtime.js");',
        'const ordinaryChunk = () => import("./server-close-OldHash.js");',
        "",
      ].join("\n"),
    );
  });

  it("rewrites reply-dispatch imports to the stable provider dispatcher runtime alias", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "provider-dispatcher.runtime-NewHash.js"),
      'export * from "./provider-dispatcher-ImplHash.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "reply-dispatch-runtime-OldHash.js"),
      ['const dispatcher = () => import("./provider-dispatcher.runtime-NewHash.js");', ""].join(
        "\n",
      ),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    writeStableRootRuntimeAliases({ rootDir });
    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "reply-dispatch-runtime-OldHash.js"), "utf8")).toBe(
      ['const dispatcher = () => import("./provider-dispatcher.runtime.js");', ""].join("\n"),
    );
    expect(await fs.readFile(path.join(distDir, "provider-dispatcher.runtime.js"), "utf8")).toBe(
      'export * from "./provider-dispatcher.runtime-NewHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "provider-dispatcher-6EQEtc-t.js"), "utf8")).toBe(
      'export * from "./provider-dispatcher.runtime.js";\n',
    );
  });

  it("keeps hashed imports when a stable runtime alias would collide", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      "export const pluginInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install-OldHash.js"),
      [
        'const pluginRuntime = () => import("./install.runtime-Aaa111.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "install-OldHash.js"), "utf8")).toBe(
      [
        'const pluginRuntime = () => import("./install.runtime-Aaa111.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
    );
  });

  it("rewrites plugin install runtime imports to stable aliases when install runtimes collide", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "install.runtime-Aaa111.js"),
      [
        "export const scanPackageInstallSource = true;",
        "export const scanFileInstallSource = true;",
        "export const scanInstalledPackageDependencyTree = true;",
        "export const scanBundleInstallSource = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-Bbb222.js"),
      "export const daemonInstall = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install-OldHash.js"),
      [
        'const pluginRuntime = () => import("./install.runtime-Aaa111.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "install-OldHash.js"), "utf8")).toBe(
      [
        'const pluginRuntime = () => import("./install.runtime.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
        "",
      ].join("\n"),
    );
  });

  it("leaves stable alias files pointing at their hashed runtime chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime-AbCd1234.js"),
      "export const ready = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime.js"),
      'export * from "./runtime-plugins.runtime-AbCd1234.js";\n',
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "runtime-plugins.runtime.js"), "utf8")).toBe(
      'export * from "./runtime-plugins.runtime-AbCd1234.js";\n',
    );
  });

  it("writes compatibility aliases for previous release runtime chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "runtime-plugins.runtime.js"),
      'export * from "./runtime-plugins.runtime-NewHash.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "provider-dispatcher.runtime.js"),
      'export * from "./provider-dispatcher.runtime-NewHash.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-NewPluginHash.js"),
      [
        "export const scanPackageInstallSource = true;",
        "export const scanFileInstallSource = true;",
        "export const scanInstalledPackageDependencyTree = true;",
        "export const scanBundleInstallSource = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "install.runtime-OtherHash.js"),
      "export const installFromValidatedNpmSpecArchive = true;\n",
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(
      await fs.readFile(path.join(distDir, "runtime-plugins.runtime-fLHuT7Vs.js"), "utf8"),
    ).toBe('export * from "./runtime-plugins.runtime.js";\n');
    expect(
      await fs.readFile(path.join(distDir, "runtime-plugins.runtime-CNAfmQRG.js"), "utf8"),
    ).toBe('export * from "./runtime-plugins.runtime.js";\n');
    expect(await fs.readFile(path.join(distDir, "provider-dispatcher-6EQEtc-t.js"), "utf8")).toBe(
      'export * from "./provider-dispatcher.runtime.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-D7SL02B2.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-Deq6Beal.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-BRVACueI.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-DX8jy7tN.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-D6FSd9v2.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-DQ-ui3nL.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-Xom5hOHq.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-tnhNR9WW.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "install.runtime-CNHwKOIb.js"), "utf8")).toBe(
      'export * from "./install.runtime-NewPluginHash.js";\n',
    );
  });

  it("writes compatibility aliases for previous text-transform runtime chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "text-transforms.runtime.js"),
      'export * from "./text-transforms.runtime-NewHash.js";\n',
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(
      await fs.readFile(path.join(distDir, "text-transforms.runtime-D9-SpAmI.js"), "utf8"),
    ).toBe('export * from "./text-transforms.runtime.js";\n');
    expect(
      await fs.readFile(path.join(distDir, "text-transforms.runtime-sEqsN4pN.js"), "utf8"),
    ).toBe('export * from "./text-transforms.runtime.js";\n');
  });

  it("writes compatibility aliases for previous gateway shutdown chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(path.join(distDir, "plugins"), { recursive: true });
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "server-close.runtime.js"),
      'export * from "./server-close.runtime-NewHash.js";\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "plugins", "hook-runner-global.js"),
      "export const runGlobalHook = true;\n",
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "server-close-DsVPJDIx.js"), "utf8")).toBe(
      'export * from "./server-close.runtime.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "server-close-DvAvfgr8.js"), "utf8")).toBe(
      'export * from "./server-close.runtime.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "hook-runner-global-B8rMIo8I.js"), "utf8")).toBe(
      'export * from "./plugins/hook-runner-global.js";\n',
    );
  });

  it("writes compatibility aliases for previous tool and ACP manager chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(path.join(distDir, "acp", "control-plane"), { recursive: true });
    await fs.mkdir(path.join(distDir, "web-fetch"), { recursive: true });
    await fs.writeFile(
      path.join(distDir, "acp", "control-plane", "manager.js"),
      "export const getAcpSessionManager = true;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(distDir, "web-fetch", "runtime.js"),
      "export const resolveWebFetchDefinition = true;\n",
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "manager-DzRWrKSA.js"), "utf8")).toBe(
      'export * from "./acp/control-plane/manager.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "runtime-CeGN4XUC.js"), "utf8")).toBe(
      'export * from "./web-fetch/runtime.js";\n',
    );
  });

  it("writes legacy CLI exit compatibility chunks", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");

    writeLegacyCliExitCompatChunks({ rootDir });

    for (const chunk of ["memory-state-CcqRgDZU.js", "memory-state-DwGdReW4.js"]) {
      await expect(fs.readFile(path.join(rootDir, "dist", chunk), "utf8")).resolves.toContain(
        "function hasMemoryRuntime()",
      );
    }
  });
});
