import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  cleanupBackupArchivePublication,
  createBackupArchivePublication,
  publishPreparedBackupArchive,
  type BackupArchivePublication,
} from "./backup-archive-publication.js";
import { writeArchiveStreamToFile, type PreparedBackupArchive } from "./backup-create-stream.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createPublication(
  prefix: string,
): Promise<{ outputDir: string; outputPath: string; plan: BackupArchivePublication }> {
  const root = tempDirs.make(prefix);
  const outputDir = path.join(root, "backups");
  const outputPath = path.join(outputDir, "backup.tar.gz");
  await fs.mkdir(outputDir, { recursive: true });
  const plan = await createBackupArchivePublication(outputPath);
  return { outputDir, outputPath, plan };
}

async function prepareArchive(
  plan: BackupArchivePublication,
  content = "complete archive",
): Promise<PreparedBackupArchive> {
  const archiveStream = new PassThrough();
  const preparedPromise = writeArchiveStreamToFile({
    archivePath: plan.tempArchivePath,
    archiveStream,
  });
  archiveStream.end(content);
  return await preparedPromise;
}

describe("backup archive publication", () => {
  it("publishes a complete archive and removes its private staging directory", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-publish-");
    const prepared = await prepareArchive(plan);
    const originalOpen = fs.open.bind(fs);
    const openedPaths: string[] = [];
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      openedPaths.push(path.resolve(String(target)));
      return await originalOpen(target, flags, mode);
    });

    try {
      await publishPreparedBackupArchive({ plan, prepared });

      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("complete archive");
      await expect(fs.lstat(prepared.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(plan.stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(openedPaths).not.toContain(path.resolve(outputPath));
    } finally {
      openSpy.mockRestore();
    }
  });

  it("removes its staging directory when private setup fails", async () => {
    const root = tempDirs.make("openclaw-backup-setup-failure-");
    const outputDir = path.join(root, "backups");
    await fs.mkdir(outputDir);
    const chmodSpy = vi
      .spyOn(fs, "chmod")
      .mockRejectedValue(Object.assign(new Error("chmod failed"), { code: "EIO" }));
    try {
      await expect(
        createBackupArchivePublication(path.join(outputDir, "backup.tar.gz")),
      ).rejects.toThrow(/chmod failed/iu);
      await expect(fs.readdir(outputDir)).resolves.toEqual([]);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it.each(["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])(
    "fails closed when hard-link publication returns %s",
    async (code) => {
      const { outputPath, plan } = await createPublication("openclaw-backup-no-link-");
      const prepared = await prepareArchive(plan);
      const linkSpy = vi
        .spyOn(fs, "link")
        .mockRejectedValue(Object.assign(new Error("unsupported"), { code }));
      try {
        await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
          /requires hard-link support/iu,
        );
        await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(prepared.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        linkSpy.mockRestore();
      }
    },
  );

  it("preserves a destination raced in before publication", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-destination-race-");
    const prepared = await prepareArchive(plan);
    await fs.writeFile(outputPath, "racer", "utf8");

    await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
      /Refusing to overwrite existing backup archive/iu,
    );
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("racer");
  });

  it("rejects a replaced staging pathname without publishing replacement bytes", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-staging-race-");
    const prepared = await prepareArchive(plan);
    const originalPath = `${prepared.archivePath}.original`;
    await fs.rename(prepared.archivePath, originalPath);
    await fs.writeFile(prepared.archivePath, "replacement", "utf8");

    await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
      /staging file changed/iu,
    );
    await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(prepared.archivePath, "utf8")).resolves.toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a requested output-parent symlink retarget",
    async () => {
      const root = tempDirs.make("openclaw-backup-parent-retarget-");
      const firstDir = path.join(root, "first");
      const secondDir = path.join(root, "second");
      const requestedDir = path.join(root, "current");
      await fs.mkdir(firstDir);
      await fs.mkdir(secondDir);
      await fs.symlink(firstDir, requestedDir);
      const outputPath = path.join(requestedDir, "backup.tar.gz");
      const plan = await createBackupArchivePublication(outputPath);
      const prepared = await prepareArchive(plan);
      await fs.unlink(requestedDir);
      await fs.symlink(secondDir, requestedDir);

      await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
        /output directory changed/iu,
      );
      await expect(fs.lstat(path.join(firstDir, "backup.tar.gz"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(secondDir, "backup.tar.gz"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a canonical output-parent directory replacement",
    async () => {
      const { outputDir, outputPath, plan } = await createPublication(
        "openclaw-backup-parent-replace-",
      );
      const prepared = await prepareArchive(plan);
      const movedOutputDir = `${outputDir}.moved`;
      await fs.rename(outputDir, movedOutputDir);
      await fs.mkdir(outputDir);

      await expect(
        publishPreparedBackupArchive({
          plan,
          prepared,
        }),
      ).rejects.toThrow(/output directory changed/iu);
      await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32").each(["EIO", "EINVAL"])(
    "preserves the complete final archive when commit directory sync fails with %s",
    async (code) => {
      const { outputPath, plan } = await createPublication("openclaw-backup-sync-failure-");
      const prepared = await prepareArchive(plan);
      const log = vi.fn();
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
        if (path.resolve(String(target)) === path.resolve(plan.canonicalParentPath)) {
          return {
            close: vi.fn().mockResolvedValue(undefined),
            sync: vi.fn().mockRejectedValue(Object.assign(new Error("sync failed"), { code })),
          } as unknown as FileHandle;
        }
        return await originalOpen(target, flags, mode);
      });
      try {
        await expect(publishPreparedBackupArchive({ plan, prepared, log })).rejects.toThrow(
          /sync failed/iu,
        );
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("complete archive");
        expect(log).toHaveBeenCalledWith(expect.stringContaining("concurrent replacement"));
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it("preserves a destination that replaces the linked archive before validation", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-linked-race-");
    const prepared = await prepareArchive(plan);
    const displacedPath = `${outputPath}.displaced`;
    const originalLstat = fs.lstat.bind(fs);
    let targetLstatCount = 0;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(plan.canonicalOutputPath)) {
        targetLstatCount += 1;
      }
      if (targetLstatCount === 2) {
        targetLstatCount += 1;
        await fs.rename(plan.canonicalOutputPath, displacedPath);
        await fs.writeFile(plan.canonicalOutputPath, "racer", "utf8");
      }
      return await originalLstat(target, options);
    });
    try {
      await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
        /Backup archive changed during publication/iu,
      );
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("racer");
      await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("complete archive");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("keeps the committed final archive when staging cleanup fails", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-cleanup-failure-");
    const prepared = await prepareArchive(plan);
    const log = vi.fn();
    const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
    const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(prepared.archivePath)) {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return originalUnlinkSync(target);
    });
    try {
      await expect(publishPreparedBackupArchive({ plan, prepared, log })).resolves.toBeUndefined();
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("complete archive");
      expect(log).toHaveBeenCalledWith(
        `Backup archiver preserved changed staging file ${prepared.archivePath}.`,
      );
    } finally {
      unlinkSpy.mockRestore();
      await cleanupBackupArchivePublication(plan);
      await expect(fs.lstat(prepared.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(plan.stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retries cleanup when descriptor and pathname identity reads initially fail", async () => {
    const { plan } = await createPublication("openclaw-backup-unidentified-partial-");
    const archiveStream = new PassThrough();
    const originalLstatSync = fsSync.lstatSync.bind(fsSync);
    const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("fstat failed"), { code: "EIO" });
    });
    let stagedLstatAttempts = 0;
    const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(plan.tempArchivePath)) {
        stagedLstatAttempts += 1;
        if (stagedLstatAttempts === 1) {
          throw Object.assign(new Error("lstat failed"), { code: "EIO" });
        }
      }
      return originalLstatSync(target, options);
    });
    try {
      const writePromise = writeArchiveStreamToFile({
        archivePath: plan.tempArchivePath,
        archiveStream,
        onPartialArchive: (receipt) => {
          plan.pendingCleanupArchives.push(receipt);
        },
      });
      archiveStream.end("partial archive");

      await expect(writePromise).rejects.toThrow("fstat failed");
      expect(plan.pendingCleanupArchives).toEqual([{ archivePath: plan.tempArchivePath }]);
    } finally {
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    await cleanupBackupArchivePublication(plan);
    await expect(fs.lstat(plan.tempArchivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(plan.stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a final-path replacement detected after the commit point", async () => {
    const { outputPath, plan } = await createPublication("openclaw-backup-final-race-");
    const prepared = await prepareArchive(plan);
    const displacedPath = `${outputPath}.displaced`;
    const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
    let replaced = false;
    const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
      if (!replaced && path.resolve(String(target)) === path.resolve(prepared.archivePath)) {
        replaced = true;
        fsSync.renameSync(plan.canonicalOutputPath, displacedPath);
        fsSync.writeFileSync(plan.canonicalOutputPath, "racer", "utf8");
      }
      return originalUnlinkSync(target);
    });
    try {
      await expect(publishPreparedBackupArchive({ plan, prepared })).rejects.toThrow(
        /Published backup archive changed/iu,
      );
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("racer");
      await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("complete archive");
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
