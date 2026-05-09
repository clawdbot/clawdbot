import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
} from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

async function expectRegularFile(filePath: string): Promise<void> {
  expect((await fs.stat(filePath)).isFile()).toBe(true);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("config backup rotation", () => {
  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const buildConfig = (version: number): OpenClawConfig =>
        ({
          agents: { list: [{ id: `v${version}` }] },
        }) as OpenClawConfig;

      const writeVersion = async (version: number) => {
        const json = JSON.stringify(buildConfig(version), null, 2).trimEnd().concat("\n");
        await fs.writeFile(configPath, json, "utf-8");
      };

      await writeVersion(0);
      for (let version = 1; version <= 6; version += 1) {
        await rotateConfigBackups(configPath, fs);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {
          // best-effort
        });
        await writeVersion(version);
      }

      const readName = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (
          (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
            ?.id ?? null
        );
      };

      await expect(readName()).resolves.toBe("v6");
      await expect(readName(".bak")).resolves.toBe("v5");
      await expect(readName(".bak.1")).resolves.toBe("v4");
      await expect(readName(".bak.2")).resolves.toBe("v3");
      await expect(readName(".bak.3")).resolves.toBe("v2");
      await expect(readName(".bak.4")).resolves.toBe("v1");
      await expectPathMissing(`${configPath}.bak.5`);
    });
  });

  // chmod is a no-op on Windows — 0o600 can never be observed there.
  it.skipIf(IS_WINDOWS)("hardenBackupPermissions sets 0o600 on all backup files", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create .bak and .bak.1 with permissive mode
      await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.1`, "secret", { mode: 0o644 });

      await hardenBackupPermissions(configPath, fs);

      const bakStat = await fs.stat(`${configPath}.bak`);
      const bak1Stat = await fs.stat(`${configPath}.bak.1`);

      expectPosixMode(bakStat.mode, 0o600);
      expectPosixMode(bak1Stat.mode, 0o600);
    });
  });

  it("cleanOrphanBackups removes stale files outside the rotation ring", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create valid backups
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "backup-0");
      await fs.writeFile(`${configPath}.bak.1`, "backup-1");
      await fs.writeFile(`${configPath}.bak.2`, "backup-2");

      // Create orphans
      await fs.writeFile(`${configPath}.bak.1772352289`, "orphan-pid");
      await fs.writeFile(`${configPath}.bak.before-marketing`, "orphan-manual");
      await fs.writeFile(`${configPath}.bak.99`, "orphan-overflow");

      await cleanOrphanBackups(configPath, fs);

      // Valid backups preserved
      await expectRegularFile(`${configPath}.bak`);
      await expectRegularFile(`${configPath}.bak.1`);
      await expectRegularFile(`${configPath}.bak.2`);

      // Orphans removed
      await expectPathMissing(`${configPath}.bak.1772352289`);
      await expectPathMissing(`${configPath}.bak.before-marketing`);
      await expectPathMissing(`${configPath}.bak.99`);

      // Main config untouched
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("current");
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
});
