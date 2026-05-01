import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
  writeLegacyCliExitCompatChunks,
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
