// Real-behavior proof: cleanupFailedManagedPluginInstall against a real
// SQLite state database and a real filesystem — nothing in the read or
// write path is mocked.
//
// Each test seeds the persisted install records through the production
// write path (normalize → SQLite), points OPENCLAW_STATE_DIR at a temp
// state dir, then calls the cleanup helper with the REAL
// loadInstalledPluginIndexInstallRecords and the REAL
// applyPluginUninstallDirectoryRemoval. This proves the attempt token
// survives normalization/persistence and that cleanup removes or retains
// the target directory based on durable SQLite state, not injected mocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import { cleanupFailedManagedPluginInstall } from "./management-service.js";

describe("cleanupFailedManagedPluginInstall — real SQLite + filesystem proof", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    clearLoadInstalledPluginIndexInstallRecordsCache();
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createFixture(): { stateDir: string; extensionsDir: string; targetDir: string } {
    // realpath first: macOS os.tmpdir() is a /var → /private/var symlink and
    // prod path comparisons resolve canonical paths.
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-")));
    tmpDirs.push(tmpDir);
    const stateDir = path.join(tmpDir, "state-home");
    const extensionsDir = path.join(tmpDir, "extensions");
    const targetDir = path.join(extensionsDir, "demo-plugin");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "index.js"), "module.exports = {}");
    fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify({ name: "demo" }));
    // cleanup reads install records with default options → process.env.
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    return { stateDir, extensionsDir, targetDir };
  }

  async function seedInstallRecords(records: Record<string, PluginInstallRecord>): Promise<void> {
    // Production write path: normalizeInstallRecordMap → JSON → SQLite.
    // candidates: [] pins discovery so the refresh never scans the host.
    await writePersistedInstalledPluginIndexInstallRecords(records, { candidates: [] });
  }

  it("persists installAttemptToken through the real normalize→SQLite→read round trip", async () => {
    const { targetDir } = createFixture();
    await seedInstallRecords({
      "demo-plugin": {
        source: "clawhub",
        installPath: targetDir,
        installAttemptToken: "txn-round-trip",
      },
    });

    const records = await loadInstalledPluginIndexInstallRecords();

    // Guards the normalizeInstallRecord allowlist: dropping the token there
    // would silently disable double-fault cleanup in production.
    expect(records["demo-plugin"]?.installAttemptToken).toBe("txn-round-trip");
  });

  it("★ DOUBLE-FAULT FIX: removes the stale target when the surviving SQLite record carries this attempt's token", async () => {
    const { extensionsDir, targetDir } = createFixture();
    const token = "txn-abc-123";
    // An unrelated plugin committed earlier must survive the cleanup untouched.
    const unrelatedDir = path.join(extensionsDir, "unrelated-plugin");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, "index.js"), "module.exports = {}");
    // Double-fault state: the failed transaction's record survived rollback.
    await seedInstallRecords({
      "demo-plugin": { source: "clawhub", installPath: targetDir, installAttemptToken: token },
      "unrelated-plugin": { source: "clawhub", installPath: unrelatedDir },
    });

    expect(fs.existsSync(targetDir)).toBe(true);

    const warnings = await cleanupFailedManagedPluginInstall({
      pluginId: "demo-plugin",
      install: { source: "clawhub", installPath: targetDir },
      targetDir,
      extensionsDir,
      attemptToken: token, // matches the durable record → stale, safe to remove
    });

    expect(warnings).toEqual([]);
    expect(fs.existsSync(targetDir)).toBe(false); // real deletion from disk
    // The unrelated committed install keeps both its files and its record.
    expect(fs.existsSync(unrelatedDir)).toBe(true);
    clearLoadInstalledPluginIndexInstallRecordsCache();
    const after = await loadInstalledPluginIndexInstallRecords();
    expect(after["unrelated-plugin"]?.installPath).toBe(unrelatedDir);
  });

  it("preserves a target whose durable record carries another process's token", async () => {
    const { extensionsDir, targetDir } = createFixture();
    // A concurrent writer committed this record; its token is not ours.
    await seedInstallRecords({
      "demo-plugin": {
        source: "clawhub",
        installPath: targetDir,
        installAttemptToken: "other-process-token",
      },
    });

    const warnings = await cleanupFailedManagedPluginInstall({
      pluginId: "demo-plugin",
      install: { source: "clawhub", installPath: targetDir },
      targetDir,
      extensionsDir,
      attemptToken: "txn-abc-123",
    });

    expect(warnings).toEqual([expect.stringContaining("retained the managed target")]);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("preserves a target whose durable record has no token (prior committed install)", async () => {
    const { extensionsDir, targetDir } = createFixture();
    await seedInstallRecords({
      "demo-plugin": { source: "clawhub", installPath: targetDir },
    });

    const warnings = await cleanupFailedManagedPluginInstall({
      pluginId: "demo-plugin",
      install: { source: "clawhub", installPath: targetDir },
      targetDir,
      extensionsDir,
      attemptToken: "txn-abc-123",
    });

    expect(warnings).toEqual([expect.stringContaining("retained the managed target")]);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("falls back to conservative retention when no attempt token is provided", async () => {
    const { extensionsDir, targetDir } = createFixture();
    await seedInstallRecords({
      "demo-plugin": { source: "clawhub", installPath: targetDir },
    });

    const warnings = await cleanupFailedManagedPluginInstall({
      pluginId: "demo-plugin",
      install: { source: "clawhub", installPath: targetDir },
      targetDir,
      extensionsDir,
      // attemptToken omitted → conservative path
    });

    expect(warnings).toEqual([expect.stringContaining("retained the managed target")]);
    expect(fs.existsSync(targetDir)).toBe(true);
  });

  it("removes the new target through the uninstall plan when the rollback restored prior state", async () => {
    const { extensionsDir, targetDir } = createFixture();
    // Single-fault: SQLite rollback succeeded, so no record owns the target.
    await seedInstallRecords({});

    const warnings = await cleanupFailedManagedPluginInstall({
      pluginId: "demo-plugin",
      install: { source: "clawhub", installPath: targetDir },
      targetDir,
      extensionsDir,
      attemptToken: "txn-abc-123",
    });

    expect(warnings).toEqual([]);
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
