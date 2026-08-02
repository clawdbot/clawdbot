// Covers reclaiming backup temp artifacts that a hard-killed run orphaned.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  keepBackupTempDirectoryAlive,
  sweepStaleBackupTempDirectories,
} from "./backup-temp-sweep.js";

const HOUR_MS = 60 * 60_000;
const ARCHIVE_NOW_MS = Date.UTC(2026, 4, 9, 8, 0, 0);

async function writeAgedDirectory(directoryPath: string, ageMs: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, "archive.tar.gz.tmp"), "orphaned payload\n");
  // Creating the file bumps the directory mtime, so age the directory last.
  const stamp = new Date(Date.now() - ageMs);
  await fs.utimes(path.join(directoryPath, "archive.tar.gz.tmp"), stamp, stamp);
  await fs.utimes(directoryPath, stamp, stamp);
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  return await fs.stat(directoryPath).then(
    () => true,
    () => false,
  );
}

async function withTempRootEnv<T>(tempRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
  }
}

describe("createBackupArchive stale temp sweep", () => {
  it("removes a staging directory orphaned by an earlier hard-killed run", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-staging-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        const orphan = path.join(tempRoot, "openclaw-backup-a1b2c3");
        await writeAgedDirectory(orphan, 48 * HOUR_MS);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await directoryExists(orphan)).toBe(false);
      },
    );
  });

  it("removes a publish staging directory orphaned beside the output archive", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-publish-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const orphan = path.join(outputDir, `.openclaw-backup-publish-${randomUUID()}-a1b2c3`);
        await writeAgedDirectory(orphan, 48 * HOUR_MS);

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await directoryExists(orphan)).toBe(false);
      },
    );
  });

  it("keeps a staging directory whose archive is still being written", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-active-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // A long tar write never touches the parent directory, so a live run
        // can carry a stale directory mtime alongside a fresh archive file.
        const activeRun = path.join(tempRoot, "openclaw-backup-c3d4e5");
        await writeAgedDirectory(activeRun, 48 * HOUR_MS);
        const now = new Date();
        await fs.utimes(path.join(activeRun, "archive.tar.gz.tmp"), now, now);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await directoryExists(activeRun)).toBe(true);
      },
    );
  });

  it("keeps recent, sibling-owned, and non-mkdtemp directories", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-scope-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // `openclaw-backup-` prefixes `openclaw-backup-verify-sqlite-`, so a
        // prefix-only match would delete a concurrent `backup verify` run.
        const concurrentVerify = path.join(tempRoot, "openclaw-backup-verify-sqlite-a1b2c3");
        const concurrentCreate = path.join(tempRoot, "openclaw-backup-b2c3d4");
        const unrelatedName = path.join(tempRoot, "openclaw-backup-user-notes");
        const unrelatedDir = path.join(tempRoot, "unrelated-data");
        await writeAgedDirectory(concurrentVerify, 48 * HOUR_MS);
        await writeAgedDirectory(concurrentCreate, 0);
        await writeAgedDirectory(unrelatedName, 48 * HOUR_MS);
        await writeAgedDirectory(unrelatedDir, 48 * HOUR_MS);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await directoryExists(concurrentVerify)).toBe(true);
        expect(await directoryExists(concurrentCreate)).toBe(true);
        expect(await directoryExists(unrelatedName)).toBe(true);
        expect(await directoryExists(unrelatedDir)).toBe(true);
      },
    );
  });
});

describe("live-owner fence", () => {
  // `tar` only reads the staging directory, so a backup whose archive stream
  // runs longer than the orphan window would age out while still live.
  const STAGING_PATTERN = /^openclaw-backup-[A-Za-z0-9]{6}$/u;

  // Both cases share one fixture and one elapsed window; only the live owner
  // differs, so the assertion isolates the fence itself.
  async function withStagingRootPastOrphanWindow(
    run: (params: { root: string; staging: string }) => Promise<void>,
  ): Promise<void> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fence-")));
    vi.useFakeTimers();
    try {
      const staging = path.join(root, "openclaw-backup-liv001");
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, "manifest.json"), "{}\n");
      await run({ root, staging });
    } finally {
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  it("keeps a staging directory alive across a full orphan window", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      const stopKeepAlive = keepBackupTempDirectoryAlive(staging);
      // Models an archive stream that outlives the window: `tar` only reads
      // staging, so the heartbeat is the sole thing keeping it claimed.
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);
      stopKeepAlive();

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await directoryExists(staging)).toBe(true);
    });
  });

  it("reclaims the same directory when no owner refreshes it", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      // Negative control: the hard-kill case, identical but with no live owner.
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await directoryExists(staging)).toBe(false);
    });
  });
});
