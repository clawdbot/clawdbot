import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logoutWeb,
  pickWebChannel,
  readWebAuthSnapshot,
  readWebAuthState,
  restoreCredsFromBackupIfNeeded,
  webAuthExists,
  WhatsAppAuthUnstableError,
  WHATSAPP_AUTH_UNSTABLE_CODE,
} from "./auth-store.js";
import type { CredsQueueWaitResult } from "./creds-persistence.js";

const hoisted = vi.hoisted(() => ({
  waitForCredsSaveQueueWithTimeout: vi.fn<() => Promise<CredsQueueWaitResult>>(
    async () => "drained",
  ),
}));

vi.mock("./creds-persistence.js", async () => {
  const actual =
    await vi.importActual<typeof import("./creds-persistence.js")>("./creds-persistence.js");
  return {
    ...actual,
    waitForCredsSaveQueueWithTimeout: hoisted.waitForCredsSaveQueueWithTimeout,
  };
});

function createTempAuthDir(prefix: string) {
  return fsSync.mkdtempSync(
    path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`),
  );
}

describe("auth-store", () => {
  beforeEach(() => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue("drained");
  });

  it("does not restore creds from backup on ordinary reads", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-read");
    const credsPath = path.join(authDir, "creds.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");

    await expect(webAuthExists(authDir)).resolves.toBe(false);
    expect(fsSync.existsSync(credsPath)).toBe(false);
  });

  it("restores creds from a regular backup file", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-restore");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, "{", "utf-8");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json.bak"),
      JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
      "utf-8",
    );

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(true);
    expect(JSON.parse(fsSync.readFileSync(credsPath, "utf-8"))).toEqual({
      me: { id: "123@s.whatsapp.net" },
    });
  });

  it("refuses to restore creds from a symlinked backup path", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-restore-symlink");
    const targetPath = path.join(authDir, "backup-target.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(targetPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");
    fsSync.symlinkSync(targetPath, backupPath);
    fsSync.writeFileSync(credsPath, "{", "utf-8");

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{");
  });

  it("reports linked auth state and snapshot from the shared read helper", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-linked");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
      "utf-8",
    );

    await expect(readWebAuthState(authDir)).resolves.toBe("linked");
    await expect(readWebAuthSnapshot(authDir)).resolves.toMatchObject({
      state: "linked",
      authAgeMs: expect.any(Number),
      selfId: expect.objectContaining({ e164: "+15551234567" }),
    });
  });

  it("reports unstable auth state when the shared barrier read times out", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-unstable-state");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
      "utf-8",
    );
    hoisted.waitForCredsSaveQueueWithTimeout
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("timed_out");

    await expect(readWebAuthState(authDir)).resolves.toBe("unstable");
    await expect(readWebAuthSnapshot(authDir)).resolves.toEqual({
      state: "unstable",
      authAgeMs: null,
      selfId: { e164: null, jid: null, lid: null },
    });
  });

  it("clears unreadable auth state on explicit logout", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-logout");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{", "utf-8");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json.bak"),
      JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
      "utf-8",
    );

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  it("does not delete the whole legacy auth root when targeted cleanup fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-legacy-failure");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");
    fsSync.writeFileSync(path.join(authDir, "oauth.json"), '{"token":true}', "utf-8");
    fsSync.writeFileSync(path.join(authDir, "session-abc.json"), "{}", "utf-8");
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).endsWith("creds.json")) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return await originalRm.call(fs, target, options as never);
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(
      logoutWeb({ authDir, isLegacyAuthDir: true, runtime: runtime as never }),
    ).rejects.toThrow("EACCES");
    expect(fsSync.existsSync(authDir)).toBe(true);
    expect(fsSync.existsSync(path.join(authDir, "oauth.json"))).toBe(true);
    rmSpy.mockRestore();
  });

  it("clears auth state even when directory enumeration fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-readdir");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
    readdirSpy.mockRestore();
  });

  it("does not delete unrelated non-empty directories on logout", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-unrelated");
    fsSync.writeFileSync(path.join(authDir, "notes.txt"), "keep me", "utf-8");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(false);
    expect(fsSync.existsSync(authDir)).toBe(true);
    expect(fsSync.existsSync(path.join(authDir, "notes.txt"))).toBe(true);
  });

  it("throws a typed unstable-auth error when channel selection times out", async () => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockResolvedValueOnce("timed_out");

    await expect(pickWebChannel("auto", "/tmp/openclaw-wa-auth-unstable")).rejects.toEqual(
      expect.objectContaining({
        code: WHATSAPP_AUTH_UNSTABLE_CODE,
        name: WhatsAppAuthUnstableError.name,
      }),
    );
  });
});
