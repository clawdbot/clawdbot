import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  backupVerifyCommandMock,
  createBackupTestRuntime,
  mockStateOnlyBackupPlan,
  resetBackupTempHome,
  tarCreateMock,
} from "./backup.test-support.js";

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
      tarCreateMock.mockRejectedValueOnce(new Error("disk full"));

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

  it("does not overwrite an archive created after readiness checks complete", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-race-",
    });
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link");
    try {
      tarCreateMock.mockImplementationOnce(async ({ file }: { file: string }) => {
        await fs.writeFile(file, "archive-bytes", "utf8");
      });
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

  it("falls back to exclusive copy when hard-link publication is unsupported", async () => {
    const { archiveDir, outputPath, runtime } = await prepareAtomicBackupScenario({
      archivePrefix: "openclaw-backup-copy-fallback-",
    });
    const linkSpy = vi.spyOn(fs, "link");
    try {
      tarCreateMock.mockImplementationOnce(async ({ file }: { file: string }) => {
        await fs.writeFile(file, "archive-bytes", "utf8");
      });
      linkSpy.mockRejectedValueOnce(
        Object.assign(new Error("hard links not supported"), { code: "EOPNOTSUPP" }),
      );

      const result = await backupCreateCommand(runtime, {
        output: outputPath,
      });

      expect(result.archivePath).toBe(outputPath);
      expect(await fs.readFile(outputPath, "utf8")).toBe("archive-bytes");
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
