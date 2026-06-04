// Verifies state-dir migrations preserve existing OpenClaw runtime data.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.js";

async function withStateDirFixture(run: (root: string) => Promise<void>): Promise<void> {
  try {
    await withTempDir({ prefix: "openclaw-state-dir-" }, async (root) => {
      await run(root);
    });
  } finally {
    resetAutoMigrateLegacyStateDirForTest();
  }
}

describe("legacy state dir auto-migration", () => {
  it("skips a legacy symlinked state dir when it points outside supported legacy roots", async () => {
    await withStateDirFixture(async (root) => {
      const legacySymlink = path.join(root, ".clawdbot");
      const legacyDir = path.join(root, "legacy-state-source");

      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

      const dirLinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

      const result = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.migrated).toBe(false);
      expect(result.warnings).toEqual([
        `Legacy state dir is a symlink (${legacySymlink} → ${legacyDir}); skipping auto-migration.`,
      ]);
      expect(fs.readFileSync(path.join(root, "legacy-state-source", "marker.txt"), "utf-8")).toBe(
        "ok",
      );
      expect(fs.readFileSync(path.join(root, ".clawdbot", "marker.txt"), "utf-8")).toBe("ok");
    });
  });

  it("skips state-dir migration when OPENCLAW_STATE_DIR is explicitly set", async () => {
    await withStateDirFixture(async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      fs.mkdirSync(legacyDir, { recursive: true });

      const result = await autoMigrateLegacyStateDir({
        env: { OPENCLAW_STATE_DIR: path.join(root, "custom-state") } as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result).toEqual({
        migrated: false,
        skipped: true,
        changes: [],
        warnings: [],
      });
      expect(fs.existsSync(legacyDir)).toBe(true);
    });
  });

  it("migrates the legacy plugin install index from an explicit state dir", async () => {
    await withStateDirFixture(async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      const stateDir = path.join(root, "custom-state");
      const sourcePath = path.join(stateDir, "plugins", "installs.json");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        JSON.stringify({
          records: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
            },
          },
        }),
        "utf8",
      );

      const result = await autoMigrateLegacyStateDir({
        env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.migrated).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.changes).toContain(
        "Migrated plugin install index 1 record → shared SQLite state",
      );
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(sourcePath)).toBe(false);
      await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
        installRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
      });
    });
  });

  it("only runs once per process until reset", async () => {
    await withStateDirFixture(async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

      const first = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });
      const second = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(first.migrated).toBe(true);
      expect(second).toEqual({
        migrated: false,
        skipped: true,
        changes: [],
        warnings: [],
      });
    });
  });

  it("migrates the legacy plugin install index before config reads", async () => {
    await withStateDirFixture(async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const sourcePath = path.join(stateDir, "plugins", "installs.json");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        JSON.stringify({
          records: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
            },
          },
        }),
        "utf8",
      );

      const result = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.migrated).toBe(true);
      expect(result.changes).toContain(
        "Migrated plugin install index 1 record → shared SQLite state",
      );
      expect(fs.existsSync(sourcePath)).toBe(false);
      await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
        installRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
      });
    });
  });
});
