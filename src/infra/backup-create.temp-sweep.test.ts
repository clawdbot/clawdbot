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

// Mirrors the private `OWNER_MARKER_FILENAME` constant in backup-temp-sweep.ts.
// Not exported from there — an export used only by this test file trips the
// project's knip dead-export check — so fixtures below that need to prove a
// directory *was* claimed write this marker directly instead of going
// through `keepBackupTempDirectoryAlive`, whose stop function always removes
// it as part of a clean finish (see that function's own comment).
const OWNER_MARKER_FILENAME = ".openclaw-backup-owner";

async function writeAgedDirectory(directoryPath: string, ageMs: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, "archive.tar.gz.tmp"), "orphaned payload\n");
  // Creating the file bumps the directory mtime, so age the directory last.
  const stamp = new Date(Date.now() - ageMs);
  await fs.utimes(path.join(directoryPath, "archive.tar.gz.tmp"), stamp, stamp);
  await fs.utimes(directoryPath, stamp, stamp);
}

// Same fixture as `writeAgedDirectory`, but also carries the ownership
// marker a real run writes immediately after `mkdtemp`. This models a
// genuine orphan of *this* format (heartbeat-aware, hard-killed after
// claiming ownership) rather than a pre-upgrade directory that never had the
// chance to claim it.
async function writeAgedOwnedDirectory(directoryPath: string, ageMs: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, OWNER_MARKER_FILENAME), "");
  await fs.writeFile(path.join(directoryPath, "archive.tar.gz.tmp"), "orphaned payload\n");
  const stamp = new Date(Date.now() - ageMs);
  const entries = await fs.readdir(directoryPath);
  for (const entry of entries) {
    await fs.utimes(path.join(directoryPath, entry), stamp, stamp);
  }
  await fs.utimes(directoryPath, stamp, stamp);
}

async function pathExists(targetPath: string): Promise<boolean> {
  return await fs.stat(targetPath).then(
    () => true,
    () => false,
  );
}

async function withTempRootEnv<T>(tempRoot: string, run: () => Promise<T>): Promise<T> {
  // os.tmpdir() reads TMPDIR on POSIX but TEMP/TMP on Windows, so override all
  // three — otherwise this sweep test never redirects the temp root on Windows.
  const names = ["TMPDIR", "TEMP", "TMP"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    process.env[name] = tempRoot;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
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
        await writeAgedOwnedDirectory(orphan, 48 * HOUR_MS);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(orphan)).toBe(false);
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
        await writeAgedOwnedDirectory(orphan, 48 * HOUR_MS);

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(orphan)).toBe(false);
      },
    );
  });

  it("leaves an aged staging directory alone when no run ever claimed it", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-legacy-staging-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // Exact name shape a pre-upgrade (pre-heartbeat) build would also
        // produce, but nothing ever wrote the ownership marker onto it. That
        // could mean an orphan of this build, or a still-running backup from
        // the older one — the two are indistinguishable by age alone, so the
        // conservative sweep must leave it alone either way.
        const possiblyLiveLegacyRun = path.join(tempRoot, "openclaw-backup-1eGacy");
        await writeAgedDirectory(possiblyLiveLegacyRun, 48 * HOUR_MS);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(possiblyLiveLegacyRun)).toBe(true);
      },
    );
  });

  it("preserves an aged Fleet archive temp file beside the output", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-fleet-file-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        // Fleet backup publishes through the same `<archive>.<uuid>.tmp`
        // shape as the retired backup-create writer. Backup-create cannot
        // prove ownership of this sibling artifact, even after it ages out.
        const fleetTemp = path.join(outputDir, `fleet-backup.tar.gz.${randomUUID()}.tmp`);
        await fs.writeFile(fleetTemp, "fleet payload\n");
        const aged = new Date(Date.now() - 48 * HOUR_MS);
        await fs.utimes(fleetTemp, aged, aged);

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(fleetTemp)).toBe(true);
      },
    );
  });

  it("keeps a legacy archive-temp file a live pre-durable-publish run is still writing", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-legacy-file-live-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const liveFile = path.join(
          outputDir,
          `2026-05-08T00-00-00.000-00-00-openclaw-backup.tar.gz.${randomUUID()}.tmp`,
        );
        // Unlike a staging directory, this file is the direct write target of
        // `tar` in the retired scheme, so its own mtime already tracks an
        // active writer with no extra fence needed.
        await fs.writeFile(liveFile, "still streaming\n");

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(liveFile)).toBe(true);
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
        await writeAgedOwnedDirectory(activeRun, 48 * HOUR_MS);
        const now = new Date();
        await fs.utimes(path.join(activeRun, "archive.tar.gz.tmp"), now, now);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(activeRun)).toBe(true);
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

        expect(await pathExists(concurrentVerify)).toBe(true);
        expect(await pathExists(concurrentCreate)).toBe(true);
        expect(await pathExists(unrelatedName)).toBe(true);
        expect(await pathExists(unrelatedDir)).toBe(true);
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
      try {
        // Models an archive stream that outlives the window: `tar` only reads
        // staging, so the heartbeat is the sole thing keeping it claimed
        // while this run — and its sweep against it — is still live.
        await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(await pathExists(staging)).toBe(true);
      } finally {
        stopKeepAlive();
      }
    });
  });

  it("reclaims the same directory once its owner stops refreshing", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      // The hard-kill case: ownership was established (the marker exists)
      // but nothing refreshes it afterward. Written directly rather than via
      // `keepBackupTempDirectoryAlive`, whose stop function always removes
      // the marker as part of a clean finish — this models the marker
      // outliving the process that wrote it, not a clean stop.
      await fs.writeFile(path.join(staging, OWNER_MARKER_FILENAME), "");
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await pathExists(staging)).toBe(false);
    });
  });

  it("leaves the same directory alone when no run ever claimed it", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      // Negative control for the marker itself: identical shape and age, but
      // no run ever wrote the ownership marker — the pre-upgrade case, which
      // must never be reclaimed no matter how idle it looks.
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await pathExists(staging)).toBe(true);
    });
  });
});
