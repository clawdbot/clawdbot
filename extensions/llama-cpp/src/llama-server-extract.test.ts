import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { selectLlamaServerAsset, type LlamaServerAsset } from "./llama-server-assets.js";
import { extractLlamaServerArchive } from "./llama-server-extract.js";

const tempRoots: string[] = [];
const TEST_ARCHIVE_ROOT = selectLlamaServerAsset("linux", "x64").archiveRoot;

afterEach(async () => {
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
  build: (buildDir: string) => Promise<void>,
): Promise<{ archivePath: string; destDir: string }> {
  const stageDir = path.join(root, "stage");
  const buildDir = path.join(stageDir, TEST_ARCHIVE_ROOT);
  await fs.mkdir(buildDir, { recursive: true });
  await build(buildDir);
  const archivePath = path.join(root, "asset.tar.gz");
  // Keep tiny fixtures synchronous: node-tar's async hard-link queue can close gzip twice.
  tar.c({ file: archivePath, cwd: stageDir, gzip: true, sync: true }, [TEST_ARCHIVE_ROOT]);
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

function withoutAliases(asset: LlamaServerAsset): LlamaServerAsset {
  return { ...asset, regularFileAliases: [] };
}

describe("extractLlamaServerArchive", () => {
  it("materializes the pinned SONAME manifest as regular files", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("linux", "x64");
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
      for (const [source, aliases] of asset.regularFileAliases) {
        await fs.writeFile(path.join(buildDir, source), `contents:${source}`);
        for (const alias of aliases) {
          await fs.symlink(source, path.join(buildDir, alias));
        }
      }
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).resolves.toBe(
      path.join(destDir, asset.archiveRoot, asset.executable),
    );

    const buildDir = path.join(destDir, asset.archiveRoot);
    for (const [source, aliases] of asset.regularFileAliases) {
      for (const alias of aliases) {
        expect((await fs.lstat(path.join(buildDir, alias))).isFile()).toBe(true);
        expect(await fs.readFile(path.join(buildDir, alias), "utf8")).toBe(`contents:${source}`);
      }
    }
  });

  it("ignores archive-provided symlink targets outside the pinned manifest", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
      await fs.symlink("../../../escape.txt", path.join(buildDir, "unexpected-link"));
    });

    await extractLlamaServerArchive({ archivePath, destDir, asset });

    await expect(
      fs.lstat(path.join(destDir, asset.archiveRoot, "unexpected-link")),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("does not publish archive-provided hard links", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      const executable = path.join(buildDir, asset.executable);
      await fs.writeFile(executable, "binary");
      await fs.link(executable, path.join(buildDir, "unexpected-hardlink"));
    });

    await extractLlamaServerArchive({ archivePath, destDir, asset });

    await expect(
      fs.lstat(path.join(destDir, asset.archiveRoot, "unexpected-hardlink")),
    ).rejects.toThrow();
  });

  it("rejects archives that exceed the llama.cpp entry budget", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await Promise.all(
        Array.from({ length: 1_000 }, (_, index) =>
          fs.writeFile(path.join(buildDir, `component-${index}`), "metadata"),
        ),
      );
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /entry count exceeds limit/u,
    );
    expect(await fs.readdir(destDir)).toStrictEqual([]);
  });

  it("rejects malformed tar input through the shared archive owner", async () => {
    const root = await createTempRoot();
    const archivePath = path.join(root, "malformed.tar.gz");
    const invalidHeader = Buffer.alloc(512);
    invalidHeader.write("bad-entry");
    await fs.writeFile(archivePath, invalidHeader);
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /invalid TAR|checksum failure/u,
    );
    expect(await fs.readdir(destDir)).toStrictEqual([]);
  });

  it("fails when a pinned regular-file alias source is absent", async () => {
    const root = await createTempRoot();
    const baseAsset = selectLlamaServerAsset("linux", "x64");
    const asset: LlamaServerAsset = {
      ...baseAsset,
      regularFileAliases: [["missing.so.1", ["missing.so"]]],
    };
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /does not contain regular alias source missing\.so\.1/u,
    );
  });

  it("rejects manifest alias names that are not basenames", async () => {
    const root = await createTempRoot();
    const baseAsset = selectLlamaServerAsset("linux", "x64");
    const asset: LlamaServerAsset = {
      ...baseAsset,
      regularFileAliases: [["../outside.so", ["alias.so"]]],
    };
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /invalid llama-server archive manifest filename/u,
    );
  });

  it("rejects a zip entry that escapes through Windows separators", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("win32", "x64");
    const { archivePath, destDir } = await createZipArchive(root, {
      "..\\..\\escape.txt": "owned",
      [asset.executable]: "binary",
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).rejects.toThrow();
    expect(await fs.readdir(destDir)).toStrictEqual([]);
    await expect(fs.stat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("extracts the flat Windows zip layout", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("win32", "x64");
    const { archivePath, destDir } = await createZipArchive(root, {
      [asset.executable]: "binary",
      "ggml-base.dll": "library",
    });

    await expect(extractLlamaServerArchive({ archivePath, destDir, asset })).resolves.toBe(
      path.join(destDir, asset.executable),
    );
    expect((await fs.readdir(destDir)).toSorted()).toStrictEqual([
      "ggml-base.dll",
      asset.executable,
    ]);
  });
});

describe("llama-server asset alias manifests", () => {
  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ] as const)("uses unique basename-only entries for %s/%s", (platform, arch) => {
    const asset = selectLlamaServerAsset(platform, arch);
    const names = asset.regularFileAliases.flatMap(([source, aliases]) => [source, ...aliases]);

    expect(new Set(names).size).toBe(names.length);
    expect(
      names.every((name) => path.basename(name) === name && name !== "." && name !== ".."),
    ).toBe(true);
    expect(asset.archive === "zip" ? names.length === 0 : names.length > 0).toBe(true);
  });
});
