import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  copyStaticExtensionAssetsToRuntimeOverlay,
  discoverStaticExtensionAssets,
} from "../../scripts/lib/static-extension-assets.mjs";
import {
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
  rewriteRootRuntimeImportsToStableAliases,
  runRuntimePostBuild,
  writeLegacyCliExitCompatChunks,
  writeLegacyRootRuntimeCompatAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

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

describe("runtime postbuild static assets", () => {
  it("tracks plugin-owned static assets that release packaging must ship", () => {
    expect(listStaticExtensionAssetOutputs()).toEqual([
      "dist/extensions/acpx/error-format.mjs",
      "dist/extensions/acpx/mcp-command-line.mjs",
      "dist/extensions/acpx/mcp-proxy.mjs",
      "dist/extensions/diffs/assets/viewer-runtime.js",
    ]);
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

  it("copies declared static assets into dist", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const src = "extensions/acpx/src/runtime-internals/mcp-proxy.mjs";
    const dest = "dist/extensions/acpx/mcp-proxy.mjs";
    const sourcePath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "proxy-data\n", "utf8");

    copyStaticExtensionAssets({
      rootDir,
      assets: [{ src, dest }],
    });

    expect(await fs.readFile(destPath, "utf8")).toBe("proxy-data\n");
  });

  it("stages copied static assets byte-for-byte during the same postbuild run", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const source = "extensions/diffs/assets/viewer-runtime.js";
    const output = "assets/viewer-runtime.js";
    const distAsset = "dist/extensions/diffs/assets/viewer-runtime.js";
    const runtimeAsset = "dist-runtime/extensions/diffs/assets/viewer-runtime.js";

    await fs.mkdir(path.join(rootDir, "src", "plugin-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf8",
    );
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

  it("preserves restored dist static assets when plugin sources are absent", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const output = "assets/viewer-runtime.js";
    const distPluginDir = path.join(rootDir, "dist", "extensions", "diffs");
    const runtimeAsset = path.join(rootDir, "dist-runtime", "extensions", "diffs", output);

    await fs.mkdir(path.join(rootDir, "src", "plugin-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf8",
    );
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

  it("writes compatibility aliases for previous gateway shutdown chunk names", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, "server-close.runtime.js"),
      'export * from "./server-close.runtime-NewHash.js";\n',
      "utf8",
    );

    writeLegacyRootRuntimeCompatAliases({ rootDir });

    expect(await fs.readFile(path.join(distDir, "server-close-DsVPJDIx.js"), "utf8")).toBe(
      'export * from "./server-close.runtime.js";\n',
    );
    expect(await fs.readFile(path.join(distDir, "server-close-DvAvfgr8.js"), "utf8")).toBe(
      'export * from "./server-close.runtime.js";\n',
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
