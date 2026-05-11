import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withRealpathSymlinkRebindRace } from "../test-utils/symlink-rebind-race.js";
import type { ArchiveSecurityError } from "./archive.js";
import {
  extractArchive,
  readZipCentralDirectoryEntryCount,
  resolvePackedRootDir,
} from "./archive.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-archive-" });
const directorySymlinkType = process.platform === "win32" ? "junction" : undefined;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 15_000;

async function makeTempDir(prefix = "case") {
  return await fixtureRootTracker.make(prefix);
}

async function withArchiveCase(
  ext: "zip" | "tar",
  run: (params: { workDir: string; archivePath: string; extractDir: string }) => Promise<void>,
) {
  const workDir = await makeTempDir(ext);
  const archivePath = path.join(workDir, `bundle.${ext}`);
  const extractDir = path.join(workDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await run({ workDir, archivePath, extractDir });
}

async function writePackageArchive(params: {
  ext: "zip" | "tar";
  workDir: string;
  archivePath: string;
  fileName: string;
  content: string;
}) {
  if (params.ext === "zip") {
    const zip = new JSZip();
    zip.file(`package/${params.fileName}`, params.content);
    await fs.writeFile(params.archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return;
  }

  const packageDir = path.join(params.workDir, "package");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, params.fileName), params.content);
  await tar.c({ cwd: params.workDir, file: params.archivePath }, ["package"]);
}

async function createDirectorySymlink(targetDir: string, linkPath: string) {
  await fs.symlink(targetDir, linkPath, directorySymlinkType);
}

async function expectRejectedCode(promise: Promise<unknown>, expected: string | RegExp) {
  try {
    await promise;
  } catch (error) {
    const code = (error as Partial<ArchiveSecurityError>).code;
    if (typeof expected === "string") {
      expect(code).toBe(expected);
      return;
    }
    expect(String(code)).toMatch(expected);
    return;
  }
  throw new Error("expected promise to reject");
}

async function expectPathMissing(filePath: string) {
  await expectRejectedCode(fs.stat(filePath), "ENOENT");
}

async function expectExtractedSizeBudgetExceeded(params: {
  archivePath: string;
  destDir: string;
  timeoutMs?: number;
  maxExtractedBytes: number;
}) {
  await expect(
    extractArchive({
      archivePath: params.archivePath,
      destDir: params.destDir,
      timeoutMs: params.timeoutMs ?? ARCHIVE_EXTRACT_TIMEOUT_MS,
      limits: { maxExtractedBytes: params.maxExtractedBytes },
    }),
  ).rejects.toThrow("archive extracted size exceeds limit");
}

function createZipCentralDirectoryArchive(params: {
  actualEntryCount: number;
  declaredEntryCount?: number;
  declaredCentralDirectorySize?: number;
}): Buffer {
  const centralDirectory = Buffer.concat(
    Array.from({ length: params.actualEntryCount }, (_, index) => {
      const name = Buffer.from(`file-${index}.txt`);
      const header = Buffer.alloc(46 + name.byteLength);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(name.byteLength, 28);
      name.copy(header, 46);
      return header;
    }),
  );
  const declaredEntryCount = params.declaredEntryCount ?? params.actualEntryCount;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 10);
  eocd.writeUInt32LE(params.declaredCentralDirectorySize ?? centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}

beforeAll(async () => {
  await fixtureRootTracker.setup();
});

afterAll(async () => {
  await fixtureRootTracker.cleanup();
});

describe("archive utils", () => {
  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "extracts $ext archives",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "hello.txt",
          content: "hi",
        });
        await extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        });
        const rootDir = await resolvePackedRootDir(extractDir);
        const content = await fs.readFile(path.join(rootDir, "hello.txt"), "utf-8");
        expect(content).toBe("hi");
      });
    },
  );

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext extraction when destination dir is a symlink",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        const realExtractDir = path.join(workDir, "real-extract");
        await fs.mkdir(realExtractDir, { recursive: true });
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "hello.txt",
          content: "hi",
        });
        await fs.rm(extractDir, { recursive: true, force: true });
        await createDirectorySymlink(realExtractDir, extractDir);

        await expectRejectedCode(
          extractArchive({
            archivePath,
            destDir: extractDir,
            timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
          }),
          "destination-symlink",
        );

        await expectPathMissing(path.join(realExtractDir, "package", "hello.txt"));
      });
    },
  );

  it("rejects zip path traversal (zip slip)", async () => {
    await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
      const zip = new JSZip();
      zip.file("../b/evil.txt", "pwnd");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        }),
      ).rejects.toThrow(/(escapes destination|absolute)/i);
    });
  });

  it("rejects zip entries that traverse pre-existing destination symlinks", async () => {
    await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
      const outsideDir = path.join(workDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await createDirectorySymlink(outsideDir, path.join(extractDir, "escape"));

      const zip = new JSZip();
      zip.file("escape/pwn.txt", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expectRejectedCode(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        }),
        "destination-symlink-traversal",
      );

      const outsideFile = path.join(outsideDir, "pwn.txt");
      const outsideExists = await fs
        .stat(outsideFile)
        .then(() => true)
        .catch(() => false);
      expect(outsideExists).toBe(false);
    });
  });

  it("does not clobber out-of-destination file when parent dir is symlink-rebound during zip extract", async () => {
    await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
      const outsideDir = path.join(workDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      const slotDir = path.join(extractDir, "slot");
      await fs.mkdir(slotDir, { recursive: true });

      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "SAFE");

      const zip = new JSZip();
      zip.file("slot/target.txt", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      let rejected = false;
      try {
        await withRealpathSymlinkRebindRace({
          shouldFlip: (realpathInput) => realpathInput === slotDir,
          symlinkPath: slotDir,
          symlinkTarget: outsideDir,
          timing: "after-realpath",
          run: async () => {
            await extractArchive({
              archivePath,
              destDir: extractDir,
              timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
            });
          },
        });
      } catch (error) {
        rejected = true;
        const code = (error as Partial<ArchiveSecurityError>).code;
        expect(String(code)).toMatch(/destination-symlink-traversal|not-file/);
      }

      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("SAFE");
      if (!rejected) {
        await expect(fs.readFile(path.join(slotDir, "target.txt"), "utf8")).resolves.toBe("owned");
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects zip extraction when a hardlink appears during destination verification",
    async () => {
      await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
        const outsideDir = path.join(workDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideAlias = path.join(outsideDir, "payload.bin");
        const extractedPath = path.join(extractDir, "package", "payload.bin");

        const zip = new JSZip();
        zip.file("package/payload.bin", "owned");
        await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
        const extractedRealPath = path.join(
          await fs.realpath(extractDir),
          "package",
          "payload.bin",
        );

        const realLstat = fs.lstat.bind(fs);
        let linked = false;
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (!linked && String(args[0]) === extractedRealPath) {
            await fs.link(extractedRealPath, outsideAlias);
            linked = true;
          }
          return await realLstat(...args);
        });

        try {
          await expectRejectedCode(
            extractArchive({
              archivePath,
              destDir: extractDir,
              timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
            }),
            /^(?:destination-symlink-traversal|hardlink)$/u,
          );
        } finally {
          lstatSpy.mockRestore();
        }

        await expect(fs.readFile(outsideAlias, "utf8")).resolves.toBe("");
        await expectPathMissing(extractedPath);
      });
    },
  );

  it("rejects tar path traversal (zip slip)", async () => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const insideDir = path.join(workDir, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(workDir, "outside.txt"), "pwnd");

      await tar.c({ cwd: insideDir, file: archivePath }, ["../outside.txt"]);

      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        }),
      ).rejects.toThrow(/escapes destination/i);
    });
  });

  it("rejects tar entries that traverse pre-existing destination symlinks", async () => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const outsideDir = path.join(workDir, "outside");
      const archiveRoot = path.join(workDir, "archive-root");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.mkdir(path.join(archiveRoot, "escape"), { recursive: true });
      await fs.writeFile(path.join(archiveRoot, "escape", "pwn.txt"), "owned");
      await createDirectorySymlink(outsideDir, path.join(extractDir, "escape"));
      await tar.c({ cwd: archiveRoot, file: archivePath }, ["escape"]);

      await expectRejectedCode(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        }),
        "destination-symlink-traversal",
      );

      await expectPathMissing(path.join(outsideDir, "pwn.txt"));
    });
  });

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext archives that exceed extracted size budget",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "big.txt",
          content: "x".repeat(64),
        });

        await expectExtractedSizeBudgetExceeded({
          archivePath,
          destDir: extractDir,
          maxExtractedBytes: 32,
        });
      });
    },
  );

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext archives that exceed archive size budget",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "file.txt",
          content: "ok",
        });
        const stat = await fs.stat(archivePath);

        await expect(
          extractArchive({
            archivePath,
            destDir: extractDir,
            timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
            limits: { maxArchiveBytes: Math.max(1, stat.size - 1) },
          }),
        ).rejects.toThrow("archive size exceeds limit");
      });
    },
  );

  it("rejects zip archives whose actual central directory exceeds the entry limit before parsing", async () => {
    await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
      const archiveBytes = createZipCentralDirectoryArchive({
        actualEntryCount: 2,
        declaredEntryCount: 1,
        declaredCentralDirectorySize: 0,
      });
      await fs.writeFile(archivePath, archiveBytes);

      expect(readZipCentralDirectoryEntryCount(archiveBytes)).toBe(2);
      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
          limits: { maxEntries: 1 },
        }),
      ).rejects.toThrow("archive entry count exceeds limit");
    });
  });

  it("rejects tar entries with absolute extraction paths", async () => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const inputDir = path.join(workDir, "input");
      const outsideFile = path.join(inputDir, "outside.txt");
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(outsideFile, "owned");
      await tar.c({ file: archivePath, preservePaths: true }, [outsideFile]);

      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
        }),
      ).rejects.toThrow(/absolute|drive path|escapes destination/i);
    });
  });
});
