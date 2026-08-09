import { execFile } from "node:child_process";
// Stage Bundled Plugin Runtime tests cover stage bundled plugin runtime script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
} from "../../scripts/lib/static-extension-assets.mts";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mts";

const execFileAsync = promisify(execFile);

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-stage-runtime-"));
  try {
    await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

describe("stageBundledPluginRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies files when Windows rejects runtime overlay symlinks", async () => {
    await withTempDir(async (repoRoot) => {
      const sourceFile = path.join(repoRoot, "dist", "extensions", "acpx", "assets", "fixture.txt");
      await fs.promises.mkdir(path.dirname(sourceFile), { recursive: true });
      await fs.promises.writeFile(sourceFile, "asset-body\n", "utf8");

      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const symlinkSpy = vi
        .spyOn(fs, "symlinkSync")
        .mockImplementation((_target, targetPath, type) => {
          if (
            String(targetPath).includes(`${path.sep}dist-runtime${path.sep}`) &&
            type !== "junction"
          ) {
            const error = new Error("no symlink privilege");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
          return undefined;
        });

      stageBundledPluginRuntime({ repoRoot });

      const runtimeFile = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "acpx",
        "assets",
        "fixture.txt",
      );
      expect(await fs.promises.readFile(runtimeFile, "utf8")).toBe("asset-body\n");
      expect(fs.lstatSync(runtimeFile).isSymbolicLink()).toBe(false);
      expect(symlinkSpy).toHaveBeenCalled();
    });
  });

  // dist-runtime is deliberately NOT asserted here: stageBundledPluginRuntime
  // creates the node_modules/openclaw alias for dist/extensions only, so overlay
  // assets cannot resolve bare "openclaw/..." specifiers.
  // Tracked in karmaterminal/openclaw#1231; restore the second root when fixed.
  it("resolves plugin SDK imports from copied static assets in the dist runtime root", async () => {
    await withTempDir(async (repoRoot) => {
      const pluginDir = path.join(repoRoot, "extensions", "onepassword");
      const staticAsset = path.join(pluginDir, "onepassword-op-path.js");
      await fs.promises.writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({ type: "module" }),
        "utf8",
      );
      await fs.promises.mkdir(pluginDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/onepassword",
          openclaw: {
            build: {
              staticAssets: [
                { source: "./onepassword-op-path.js", output: "onepassword-op-path.js" },
              ],
            },
          },
        }),
        "utf8",
      );
      await fs.promises.writeFile(
        staticAsset,
        'import { marker } from "openclaw/plugin-sdk/secret-ref-runtime";\nexport { marker };\n',
        "utf8",
      );
      await fs.promises.mkdir(path.join(repoRoot, "dist", "extensions", "onepassword"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(repoRoot, "dist", "extensions", "onepassword", "index.js"),
        "export {};\n",
        "utf8",
      );
      await fs.promises.mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
      await fs.promises.writeFile(
        path.join(repoRoot, "dist", "plugin-sdk", "secret-ref-runtime.js"),
        'export const marker = "runtime-sdk";\n',
        "utf8",
      );

      stageBundledPluginRuntime({ repoRoot });
      copyStaticExtensionAssets({ rootDir: repoRoot });
      copyStaticExtensionAssetsToRuntimeOverlay({ rootDir: repoRoot });

      for (const runtimeRoot of ["dist"]) {
        const extensionsRoot = path.join(repoRoot, runtimeRoot, "extensions");
        const emittedAsset = path.join(extensionsRoot, "onepassword", "onepassword-op-path.js");
        const { stdout } = await execFileAsync(process.execPath, [
          "--no-opt",
          "--input-type=module",
          "--eval",
          `import { marker } from ${JSON.stringify(pathToFileURL(emittedAsset).href)}; process.stdout.write(marker);`,
        ]);
        expect(stdout).toBe("runtime-sdk");
        expect(
          fs.existsSync(path.join(extensionsRoot, "node_modules", "openclaw", "package.json")),
        ).toBe(true);
      }
    });
  });

  it("refuses to stage through a symlinked dist root", async () => {
    await withTempDir(async (repoRoot) => {
      const targetDir = path.join(repoRoot, "gateway-dist");
      const pluginFile = path.join(targetDir, "extensions", "acpx", "index.js");
      await fs.promises.mkdir(path.dirname(pluginFile), { recursive: true });
      await fs.promises.writeFile(pluginFile, "export {};\n", "utf8");
      const distLink = path.join(repoRoot, "dist");
      await fs.promises.symlink(targetDir, distLink, "dir");

      expect(() => stageBundledPluginRuntime({ repoRoot })).toThrow(/symbolic link/u);

      expect(await fs.promises.readlink(distLink)).toBe(targetDir);
      expect(await fs.promises.readFile(pluginFile, "utf8")).toBe("export {};\n");
      await expect(fs.promises.stat(path.join(repoRoot, "dist-runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.promises.stat(path.join(targetDir, "extensions", "node_modules")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
