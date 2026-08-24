// Stage Bundled Plugin Runtime tests cover stage bundled plugin runtime script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mts";

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
