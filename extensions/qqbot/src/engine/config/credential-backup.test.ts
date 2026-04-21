import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCredentialBackupFile, getLegacyCredentialBackupFile } from "../utils/data-paths.js";
import { loadCredentialBackup, saveCredentialBackup } from "./credential-backup.js";

/**
 * These tests write to `~/.openclaw/qqbot/data` under a test-specific
 * accountId prefix and clean up after themselves. Mirrors the approach
 * used by `platform.test.ts` in the same package.
 */
describe("engine/config/credential-backup", () => {
  const acct = `test-cb-${process.pid}-${Date.now()}`;
  const legacyPath = getLegacyCredentialBackupFile();
  let legacyBackup: string | null = null;

  beforeEach(() => {
    // Preserve any legacy backup that might happen to live in the user's
    // real home so we can restore it after the test.
    legacyBackup = null;
    if (fs.existsSync(legacyPath)) {
      legacyBackup = fs.readFileSync(legacyPath, "utf8");
      fs.unlinkSync(legacyPath);
    }
  });

  afterEach(() => {
    try {
      fs.unlinkSync(getCredentialBackupFile(acct));
    } catch {
      /* ignore */
    }
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
    if (legacyBackup != null) {
      fs.writeFileSync(legacyPath, legacyBackup);
    }
  });

  it("round-trips a credential snapshot", () => {
    saveCredentialBackup(acct, "app-1", "secret-1");
    const loaded = loadCredentialBackup(acct);
    expect(loaded?.appId).toBe("app-1");
    expect(loaded?.clientSecret).toBe("secret-1");
    expect(loaded?.accountId).toBe(acct);
    expect(fs.existsSync(getCredentialBackupFile(acct))).toBe(true);
  });

  it("returns null when no backup exists", () => {
    expect(loadCredentialBackup(acct)).toBeNull();
  });

  it("returns null when legacy backup belongs to a different accountId", () => {
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accountId: "other-acct",
        appId: "app-old",
        clientSecret: "secret-old",
        savedAt: new Date().toISOString(),
      }),
    );
    expect(loadCredentialBackup(acct)).toBeNull();
  });

  it("migrates legacy single-file backup to per-account path on load", () => {
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        accountId: acct,
        appId: "app-1",
        clientSecret: "secret-1",
        savedAt: new Date().toISOString(),
      }),
    );

    const loaded = loadCredentialBackup(acct);
    expect(loaded?.appId).toBe("app-1");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(getCredentialBackupFile(acct))).toBe(true);
  });

  it("ignores empty appId/clientSecret on save", () => {
    saveCredentialBackup(acct, "", "secret");
    saveCredentialBackup(acct, "app", "");
    expect(fs.existsSync(getCredentialBackupFile(acct))).toBe(false);
  });
});
