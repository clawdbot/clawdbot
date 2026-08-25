import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as archiveSdk from "openclaw/plugin-sdk/archive";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractLlamaServerArchive } from "./llama-server-extract.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  // Resolve the mkdtemp root: macOS reports /var, while extraction compares the
  // canonical /private/var spelling.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-extract-")));
  tempRoots.push(root);
  return root;
}

async function createTarArchive(
  root: string,
  build: (stageDir: string) => Promise<void>,
): Promise<{ archivePath: string; destDir: string }> {
  const stageDir = path.join(root, "stage");
  await fs.mkdir(path.join(stageDir, "llama-build"), { recursive: true });
  await build(path.join(stageDir, "llama-build"));
  const archivePath = path.join(root, "asset.tar.gz");
  await tar.c({ file: archivePath, cwd: stageDir, gzip: true }, ["llama-build"]);
  const destDir = path.join(root, "dest");
  await fs.mkdir(destDir, { recursive: true });
  return { archivePath, destDir };
}

async function createZipArchive(
  root: string,
  entries: Record<string, string>,
): Promise<{ archivePath: string; destDir: string }> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const archivePath = path.join(root, "asset.zip");
  await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  const destDir = path.join(root, "dest");
  await fs.mkdir(destDir, { recursive: true });
  return { archivePath, destDir };
}

describe("extractLlamaServerArchive", () => {
  it("restores the SONAME aliases that the loader needs from tar assets", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, "libllama.so.0.1.0"), "shared-object");
      await fs.symlink("libllama.so.0.1.0", path.join(buildDir, "libllama.so.0"));
      await fs.symlink("libllama.so.0", path.join(buildDir, "libllama.so"));
      await fs.writeFile(path.join(buildDir, "llama-server"), "binary");
    });

    await extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" });

    const buildDir = path.join(destDir, "llama-build");
    expect(await fs.readlink(path.join(buildDir, "libllama.so.0"))).toBe("libllama.so.0.1.0");
    expect(await fs.readlink(path.join(buildDir, "libllama.so"))).toBe("libllama.so.0");
    expect(await fs.readFile(path.join(buildDir, "libllama.so"), "utf8")).toBe("shared-object");
  });

  it("rejects a tar symlink that points outside its own directory", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.symlink("../../../escape.txt", path.join(buildDir, "llama-server"));
    });

    await expect(
      extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" }),
    ).rejects.toThrow(/unsafe link target/u);
    await expect(fs.lstat(path.join(destDir, "llama-build", "llama-server"))).rejects.toThrow();
  });

  it("rejects a tar hard link instead of dropping it silently", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, "llama-server"), "binary");
      await fs.link(path.join(buildDir, "llama-server"), path.join(buildDir, "llama-server-alias"));
    });

    await expect(
      extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" }),
    ).rejects.toThrow(/unsupported hard link/u);
  });

  it("rejects an oversized release archive before extracting it", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await Promise.all(
        Array.from({ length: 1_000 }, (_, index) =>
          fs.writeFile(path.join(buildDir, `component-${index}`), "metadata"),
        ),
      );
    });

    await expect(
      extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" }),
    ).rejects.toThrow(/preflight entry limits/u);
    expect(await fs.readdir(destDir)).toStrictEqual([]);
  });

  it("shares one deadline across tar preflight and extraction", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, "llama-server"), "binary");
    });
    const extractArchive = vi.spyOn(archiveSdk, "extractArchive").mockResolvedValueOnce();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_123);

    try {
      await extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" });
    } finally {
      now.mockRestore();
    }

    expect(extractArchive).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10 * 60_000 - 123 }),
    );
  });

  it("does not restore tar aliases after the shared deadline expires", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, "libllama.so.1"), "shared-object");
      await fs.symlink("libllama.so.1", path.join(buildDir, "libllama.so"));
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(archiveSdk, "extractArchive").mockImplementationOnce(async (params) => {
      const buildDir = path.join(params.destDir, "llama-build");
      await fs.mkdir(buildDir, { recursive: true });
      await fs.writeFile(path.join(buildDir, "libllama.so.1"), "shared-object");
      now.mockReturnValue(10 * 60_000 + 1_001);
    });

    await expect(
      extractLlamaServerArchive({ archivePath, destDir, archive: "tar.gz" }),
    ).rejects.toThrow(/extraction timed out/u);
    await expect(fs.lstat(path.join(destDir, "llama-build", "libllama.so"))).rejects.toThrow();
  });

  it("rejects a zip entry that escapes through Windows separators", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createZipArchive(root, {
      "..\\..\\escape.txt": "owned",
      "llama-server.exe": "binary",
    });

    await expect(
      extractLlamaServerArchive({ archivePath, destDir, archive: "zip" }),
    ).rejects.toThrow();
    expect(await fs.readdir(destDir)).toStrictEqual([]);
    await expect(fs.stat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("extracts the flat Windows zip layout", async () => {
    const root = await createTempRoot();
    const { archivePath, destDir } = await createZipArchive(root, {
      "llama-server.exe": "binary",
      "ggml-base.dll": "library",
    });

    await extractLlamaServerArchive({ archivePath, destDir, archive: "zip" });

    expect((await fs.readdir(destDir)).toSorted()).toStrictEqual([
      "ggml-base.dll",
      "llama-server.exe",
    ]);
  });
});
