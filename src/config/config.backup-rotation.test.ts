// Covers config backup rotation limits and cleanup behavior.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const logVerboseMock = vi.hoisted(() => vi.fn());
vi.mock("../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../globals.js")>()),
  logVerbose: logVerboseMock,
}));

import { createPreUpdateConfigSnapshot, maintainConfigBackups } from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";

async function expectRegularFile(filePath: string): Promise<void> {
  expect((await fs.stat(filePath)).isFile()).toBe(true);
}

async function expectPathMissing(filePath: string): Promise<void> {
  let error: { code?: unknown } | undefined;
  try {
    await fs.stat(filePath);
  } catch (err) {
    error = err as { code?: unknown };
  }
  expect(error?.code).toBe("ENOENT");
}

describe("config backup rotation", () => {
  it("keeps five recovery points while preserving the pre-update snapshot", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const writeVersion = (version: number) =>
        fs.writeFile(configPath, JSON.stringify({ version }), "utf-8");
      const readVersion = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (JSON.parse(raw) as { version: number }).version;
      };
      const { existsSync } = await import("node:fs");

      await writeVersion(0);
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      for (let version = 1; version <= 6; version += 1) {
        await maintainConfigBackups(configPath, fs);
        await writeVersion(version);
      }

      await expect(readVersion()).resolves.toBe(6);
      await expect(readVersion(".bak")).resolves.toBe(5);
      await expect(readVersion(".bak.1")).resolves.toBe(4);
      await expect(readVersion(".bak.2")).resolves.toBe(3);
      await expect(readVersion(".bak.3")).resolves.toBe(2);
      await expect(readVersion(".bak.4")).resolves.toBe(1);
      await expectPathMissing(`${configPath}.bak.5`);
      await expect(readVersion(".pre-update")).resolves.toBe(0);
    });
  });

  it("maintainConfigBackups composes rotate/copy/harden/prune flow", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.orphan`, "old");

      await maintainConfigBackups(configPath, fs);

      // A new primary backup is created from the current config.
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets rotated into ring slot 1.
      await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
      // Windows cannot validate POSIX chmod bits, but all other compose assertions
      // should still run there.
      if (!IS_WINDOWS) {
        const primaryBackupStat = await fs.stat(`${configPath}.bak`);
        expectPosixMode(primaryBackupStat.mode, 0o600);
      }
      // Out-of-ring orphan gets pruned.
      await expectPathMissing(`${configPath}.bak.orphan`);
    });
  });

  it("createPreUpdateConfigSnapshot writes .pre-update outside rotation ring", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const content = JSON.stringify({ plugins: { installs: ["matrix"] } });
      await fs.writeFile(configPath, content, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      const snapshotPath = `${configPath}.pre-update`;
      await expectRegularFile(snapshotPath);
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(content);
      if (!IS_WINDOWS) {
        const stat = await fs.stat(snapshotPath);
        expectPosixMode(stat.mode, 0o600);
      }
    });
  });

  it("createPreUpdateConfigSnapshot replaces a preexisting snapshot once per process", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const stale = JSON.stringify({ snapshot: "stale" });
      const current = JSON.stringify({ snapshot: "current" });
      const second = JSON.stringify({ snapshot: "second" });
      const snapshotPath = `${configPath}.pre-update`;
      await fs.writeFile(configPath, current, { mode: 0o600 });
      await fs.writeFile(snapshotPath, stale, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);

      // Later writes in the same update attempt should not replace the first snapshot.
      await fs.writeFile(configPath, second);
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);
    });
  });

  it("createPreUpdateConfigSnapshot is a no-op when config does not exist", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const { existsSync } = await import("node:fs");

      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      await expectPathMissing(`${configPath}.pre-update`);
    });
  });

  it("retries snapshot after transient read and write errors (#105431)", async () => {
    await withTempHome(async () => {
      const content = JSON.stringify({ plugins: { installs: ["slack"] } });
      const { existsSync } = await import("node:fs");
      const rejectingReadFile = (async () => {
        throw new Error("EIO: transient read error");
      }) as typeof fs.readFile;
      const rejectingWriteFile = (async () => {
        throw new Error("ENOSPC: transient write error");
      }) as typeof fs.writeFile;

      for (const failingOperation of ["read", "write"] as const) {
        const configPath = `${resolveConfigPathFromTempState()}.${failingOperation}`;
        await fs.writeFile(configPath, content, { mode: 0o600 });

        await createPreUpdateConfigSnapshot({
          configPath,
          fs: {
            readFile: failingOperation === "read" ? rejectingReadFile : fs.readFile,
            writeFile: failingOperation === "write" ? rejectingWriteFile : fs.writeFile,
            existsSync,
          },
        });
        await expectPathMissing(`${configPath}.pre-update`);

        await createPreUpdateConfigSnapshot({
          configPath,
          fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
        });

        const snapshotPath = `${configPath}.pre-update`;
        await expectRegularFile(snapshotPath);
        await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(content);
      }
    });
  });

  it("logs an orphan backup cleanup failure instead of swallowing it (#105199)", async () => {
    await withTempHome(async () => {
      logVerboseMock.mockClear();
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      const lockedOrphan = `${configPath}.bak.orphan`;
      await fs.writeFile(lockedOrphan, "orphan");

      // A locked/undeletable orphan: unlink rejects for this entry only, so rotate/copy/harden
      // still run on the real fs and only the orphan prune step hits the failure path.
      const ioFs = {
        ...fs,
        unlink: (target: string) =>
          target === lockedOrphan
            ? Promise.reject(
                Object.assign(new Error("EPERM: operation not permitted, unlink"), {
                  code: "EPERM",
                }),
              )
            : fs.unlink(target),
      };

      // maintainConfigBackups must not throw, and the swallowed prune failure is now surfaced.
      await maintainConfigBackups(configPath, ioFs);

      const logged = logVerboseMock.mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => line.includes(lockedOrphan) && line.includes("EPERM"))).toBe(
        true,
      );
    });
  });
});
