import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverStaticExtensionAssets } from "../../scripts/lib/static-extension-assets.mjs";
import {
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
  rewriteRootRuntimeImportsToStableAliases,
  writeLegacyCliExitCompatChunks,
  writeLegacyRootRuntimeCompatAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("runtime postbuild static assets", () => {
  it("tracks plugin-owned static assets that release packaging must ship", () => {
    expect(listStaticExtensionAssetOutputs()).toEqual(
      expect.arrayContaining([
        "dist/extensions/acpx/error-format.mjs",
        "dist/extensions/acpx/mcp-command-line.mjs",
        "dist/extensions/acpx/mcp-proxy.mjs",
        "dist/extensions/diffs/assets/viewer-runtime.js",
      ]),
    );
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
    await expect(fs.stat(path.join(distDir, "library.js"))).rejects.toThrow();
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

    await expect(fs.stat(path.join(distDir, "install.runtime.js"))).rejects.toThrow();
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
