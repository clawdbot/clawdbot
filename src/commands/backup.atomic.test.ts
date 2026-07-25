// Backup atomicity tests cover temp-file writes, rollback behavior, and backup archive consistency.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  backupVerifyCommandMock,
  createMockTarStream,
  createBackupTestRuntime,
  mockStateOnlyBackupPlan,
  resetBackupTempHome,
  tarCreateMock,
} from "./backup.test-support.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

vi.mock("../utils/sleep.js", () => ({
  sleep: (ms: number) => sleepMock(ms),
}));

const { backupCreateCommand } = await import("./backup.js");

describe("backupCreateCommand atomic archive write", () => {
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-atomic-test-");
  });

  beforeEach(async () => {
    await resetBackupTempHome(tempHome);
    tarCreateMock.mockReset();
    backupVerifyCommandMock.mockReset();
    sleepMock.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  async function prepareAtomicBackupScenario(params: {
    archivePrefix: string;
    outputName?: string;
  }) {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), params.archivePrefix));
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

    const runtime = createBackupTestRuntime();
    const outputPath = path.join(archiveDir, params.outputName ?? "backup.tar.gz");

    await mockStateOnlyBackupPlan(stateDir);

    return {
      archiveDir,
      outputPath,
      runtime,
    };
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fs.access(targetPath);
      throw new Error(`expected missing path: ${targetPath}`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  }

  it("does not leave a partial final archive behind when tar creation fails", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-failure-",
    });
    try {
      tarCreateMock.mockReturnValueOnce(createMockTarStream({ error: new Error("disk full") }));

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/disk full/i);

      await expectPathMissing(outputPath);
      const remaining = await fs.readdir(archiveDir);
      expect(remaining).toStrictEqual([]);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("cleans intermediate retry archives after a later attempt succeeds", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-retry-cleanup-",
    });
    const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
    let blockedPartialPath: string | undefined;
    let blockedPartialCleanupAttempts = 0;
    const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
      const targetPath = path.resolve(String(target));
      if (!blockedPartialPath && targetPath.endsWith("archive.tar.gz.tmp")) {
        blockedPartialPath = targetPath;
      }
      if (targetPath === blockedPartialPath) {
        blockedPartialCleanupAttempts += 1;
        if (blockedPartialCleanupAttempts === 1) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
      }
      return originalUnlinkSync(target);
    });
    try {
      let tarAttempt = 0;
      tarCreateMock.mockImplementation(() => {
        tarAttempt += 1;
        return createMockTarStream({
          contents: `archive-attempt-${tarAttempt}`,
          ...(tarAttempt < 3
            ? {
                error: Object.assign(new Error("did not encounter expected EOF"), {
                  path: path.join(tempHome.home, ".openclaw", "state.txt"),
                }),
              }
            : {}),
        });
      });

      const result = await backupCreateCommand(runtime, {
        output: outputPath,
      });

      expect(result.archivePath).toBe(outputPath);
      expect(sleepMock.mock.calls).toStrictEqual([[10_000], [20_000]]);
      expect(blockedPartialCleanupAttempts).toBeGreaterThanOrEqual(2);
      expect((await fs.readdir(archiveDir)).toSorted()).toStrictEqual([path.basename(outputPath)]);
    } finally {
      unlinkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an archive created after readiness checks complete", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-race-",
    });
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link");
    try {
      tarCreateMock.mockReturnValueOnce(createMockTarStream());
      linkSpy.mockImplementationOnce(async (existingPath, newPath) => {
        await fs.writeFile(newPath, "concurrent-archive", "utf8");
        return await realLink(existingPath, newPath);
      });

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/refusing to overwrite existing backup archive/i);

      expect(await fs.readFile(outputPath, "utf8")).toBe("concurrent-archive");
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails closed when hard-link publication is unsupported", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-no-hardlink-",
    });
    const linkSpy = vi.spyOn(fs, "link");
    try {
      tarCreateMock.mockReturnValueOnce(createMockTarStream());
      linkSpy.mockRejectedValueOnce(
        Object.assign(new Error("hard links not supported"), { code: "EOPNOTSUPP" }),
      );

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/requires hard-link support/iu);
      await expectPathMissing(outputPath);
      await expect(fs.readdir(archiveDir)).resolves.toEqual([]);
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
