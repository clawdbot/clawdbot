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
  oauthDir: "/tmp/openclaw-wa-auth-store-test-oauth",
}));

vi.mock("./creds-persistence.js", async () => {
  const actual =
    await vi.importActual<typeof import("./creds-persistence.js")>("./creds-persistence.js");
  return {
    ...actual,
    waitForCredsSaveQueueWithTimeout: hoisted.waitForCredsSaveQueueWithTimeout,
  };
});

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => hoisted.oauthDir,
}));

function createTempAuthDir(prefix: string) {
  return fsSync.mkdtempSync(
    path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`),
  );
}

function withOwnedOAuthAuthDir<T>(
  prefix: string,
  run: (authDir: string) => Promise<T>,
): Promise<T> {
  const previousOAuthDir = hoisted.oauthDir;
  const oauthDir = createTempAuthDir(`${prefix}-oauth`);
  const authDir = path.join(oauthDir, "whatsapp", "default");
  fsSync.mkdirSync(authDir, { recursive: true });
  hoisted.oauthDir = oauthDir;
  return run(authDir).finally(() => {
    hoisted.oauthDir = previousOAuthDir;
    fsSync.rmSync(oauthDir, { recursive: true, force: true });
  });
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
    const snapshot = await readWebAuthSnapshot(authDir);
    expect(snapshot.authAgeMs).toBeTypeOf("number");
    expect(snapshot.authAgeMs).toBeGreaterThanOrEqual(0);
    expect(snapshot).toEqual({
      state: "linked",
      authAgeMs: snapshot.authAgeMs,
      selfId: {
        e164: "+15551234567",
        jid: "15551234567@s.whatsapp.net",
        lid: null,
      },
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
    await withOwnedOAuthAuthDir("openclaw-wa-auth-logout", async (authDir) => {
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
  });

  it("does not delete the whole legacy auth root when targeted cleanup fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-legacy-failure");
    const previousOAuthDir = hoisted.oauthDir;
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");
    fsSync.writeFileSync(path.join(authDir, "oauth.json"), '{"token":true}', "utf-8");
    fsSync.writeFileSync(path.join(authDir, "session-abc.json"), "{}", "utf-8");
    hoisted.oauthDir = authDir;
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

    try {
      await expect(
        logoutWeb({ authDir, isLegacyAuthDir: true, runtime: runtime as never }),
      ).rejects.toThrow("EACCES");
      expect(fsSync.existsSync(authDir)).toBe(true);
      expect(fsSync.existsSync(path.join(authDir, "oauth.json"))).toBe(true);
    } finally {
      hoisted.oauthDir = previousOAuthDir;
      rmSpy.mockRestore();
      fsSync.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("clears auth state even when directory enumeration fails", async () => {
    await withOwnedOAuthAuthDir("openclaw-wa-auth-readdir", async (authDir) => {
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
  });

  it("does not delete custom auth directories outside the OpenClaw auth root", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-custom");
    const nestedDir = path.join(authDir, "nested");
    fsSync.mkdirSync(nestedDir);
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");
    fsSync.writeFileSync(path.join(authDir, "notes.txt"), "keep me", "utf-8");
    fsSync.writeFileSync(path.join(nestedDir, "session-abc.json"), "keep me", "utf-8");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(false);
    expect(fsSync.existsSync(authDir)).toBe(true);
    expect(fsSync.existsSync(path.join(authDir, "creds.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(authDir, "notes.txt"))).toBe(true);
    expect(fsSync.existsSync(path.join(nestedDir, "session-abc.json"))).toBe(true);
  });

  it("does not clear auth files through a symlinked owned auth directory", async () => {
    const previousOAuthDir = hoisted.oauthDir;
    const oauthDir = createTempAuthDir("openclaw-wa-auth-symlink-oauth");
    const externalDir = createTempAuthDir("openclaw-wa-auth-symlink-target");
    const authDir = path.join(oauthDir, "whatsapp", "default");
    try {
      fsSync.mkdirSync(path.dirname(authDir), { recursive: true });
      fsSync.writeFileSync(path.join(externalDir, "creds.json"), "{}", "utf-8");
      fsSync.writeFileSync(path.join(externalDir, "notes.txt"), "keep me", "utf-8");
      fsSync.symlinkSync(externalDir, authDir, "dir");
      hoisted.oauthDir = oauthDir;
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(false);
      expect(fsSync.existsSync(authDir)).toBe(true);
      expect(fsSync.existsSync(path.join(externalDir, "creds.json"))).toBe(true);
      expect(fsSync.existsSync(path.join(externalDir, "notes.txt"))).toBe(true);
    } finally {
      hoisted.oauthDir = previousOAuthDir;
      fsSync.rmSync(oauthDir, { recursive: true, force: true });
      fsSync.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("does not clear auth files through an intermediate symlink in the owned auth tree", async () => {
    const previousOAuthDir = hoisted.oauthDir;
    const oauthDir = createTempAuthDir("openclaw-wa-auth-symlink-parent-oauth");
    const externalRoot = createTempAuthDir("openclaw-wa-auth-symlink-parent-target");
    const externalAuthDir = path.join(externalRoot, "default");
    const linkedParent = path.join(oauthDir, "whatsapp", "linked");
    const authDir = path.join(linkedParent, "default");
    try {
      fsSync.mkdirSync(path.dirname(linkedParent), { recursive: true });
      fsSync.mkdirSync(externalAuthDir, { recursive: true });
      fsSync.writeFileSync(path.join(externalAuthDir, "creds.json"), "{}", "utf-8");
      fsSync.writeFileSync(path.join(externalAuthDir, "notes.txt"), "keep me", "utf-8");
      fsSync.symlinkSync(externalRoot, linkedParent, "dir");
      hoisted.oauthDir = oauthDir;
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(false);
      expect(fsSync.existsSync(authDir)).toBe(true);
      expect(fsSync.existsSync(path.join(externalAuthDir, "creds.json"))).toBe(true);
      expect(fsSync.existsSync(path.join(externalAuthDir, "notes.txt"))).toBe(true);
    } finally {
      hoisted.oauthDir = previousOAuthDir;
      fsSync.rmSync(oauthDir, { recursive: true, force: true });
      fsSync.rmSync(externalRoot, { recursive: true, force: true });
    }
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

    const error = await pickWebChannel("auto", "/tmp/openclaw-wa-auth-unstable").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WhatsAppAuthUnstableError);
    expect(error).toEqual(
      Object.assign(new WhatsAppAuthUnstableError(), {
        code: WHATSAPP_AUTH_UNSTABLE_CODE,
        name: WhatsAppAuthUnstableError.name,
      }),
    );
  });
});
