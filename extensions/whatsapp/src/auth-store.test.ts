// Whatsapp tests cover auth store plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWebAuthAgeMs,
  hasWebCredsSync,
  logoutWeb,
  pickWebChannel,
  readCredsJsonRaw,
  readWebAuthSnapshot,
  readWebAuthState,
  readWebSelfId,
  readWebSelfIdentity,
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withOwnedOAuthAuthDir<T>(
  prefix: string,
  run: (authDir: string) => Promise<T>,
): Promise<T> {
  const previousOAuthDir = hoisted.oauthDir;
  const oauthDir = tempDirs.make(`${prefix}-oauth-`);
  const authDir = path.join(oauthDir, "whatsapp", "default");
  fsSync.mkdirSync(authDir, { recursive: true });
  hoisted.oauthDir = oauthDir;
  return run(authDir).finally(() => {
    hoisted.oauthDir = previousOAuthDir;
  });
}

describe("auth-store", () => {
  beforeEach(() => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue("drained");
  });

  it("does not restore creds from backup on ordinary reads", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-read-");
    const credsPath = path.join(authDir, "creds.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");

    await expect(webAuthExists(authDir)).resolves.toBe(false);
    expect(fsSync.existsSync(credsPath)).toBe(false);
  });

  it("restores malformed creds from a valid backup", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-restore-");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, "{x", "utf-8");
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

  it("revalidates setup ownership immediately before restoring backup credentials", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-guarded-restore-");
    const credsPath = path.join(authDir, "creds.json");
    const guardError = new Error("verified inference route changed");
    fsSync.writeFileSync(credsPath, "{x", "utf-8");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json.bak"),
      JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
      "utf-8",
    );

    await expect(
      restoreCredsFromBackupIfNeeded(authDir, {
        beforeCredentialPersistence: async () => {
          throw guardError;
        },
      }),
    ).rejects.toBe(guardError);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{x");
  });

  it("leaves malformed creds unchanged when the backup is malformed", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-malformed-backup-");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, "{x", "utf-8");
    fsSync.writeFileSync(path.join(authDir, "creds.json.bak"), "{y", "utf-8");

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{x");
  });

  it("preserves valid large creds instead of treating them as corrupt", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-large-creds-");
    const credsPath = path.join(authDir, "creds.json");
    const largeCreds = JSON.stringify({
      me: { id: "15551234567@s.whatsapp.net" },
      additionalData: "x".repeat(1024 * 1024 + 512),
    });
    fsSync.writeFileSync(credsPath, largeCreds, "utf-8");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json.bak"),
      JSON.stringify({ me: { id: "19990000000@s.whatsapp.net" } }),
      "utf-8",
    );

    await expect(webAuthExists(authDir)).resolves.toBe(true);
    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(largeCreds);
    expect(readWebSelfId(authDir)).toMatchObject({
      e164: "+15551234567",
      jid: "15551234567@s.whatsapp.net",
    });
  });

  it("refuses to restore creds from a symlinked backup path", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-restore-symlink-");
    const targetPath = path.join(authDir, "backup-target.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(targetPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");
    fsSync.symlinkSync(targetPath, backupPath);
    fsSync.writeFileSync(credsPath, "{", "utf-8");

    await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{");
  });

  it.runIf(process.platform !== "win32")(
    "does not restore backup over a symlinked creds path",
    async () => {
      const authDir = tempDirs.make("openclaw-wa-auth-restore-target-symlink-");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      const backupPath = path.join(authDir, "creds.json.bak");
      fsSync.writeFileSync(targetPath, "{", "utf-8");
      fsSync.symlinkSync(targetPath, credsPath);
      fsSync.writeFileSync(
        backupPath,
        JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
        "utf-8",
      );

      await expect(restoreCredsFromBackupIfNeeded(authDir)).resolves.toBe(false);
      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("{");
    },
  );

  it("reports linked auth state and snapshot from the shared read helper", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-linked-");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
      "utf-8",
    );

    await expect(readWebAuthState(authDir)).resolves.toBe("linked");
    const snapshot = await readWebAuthSnapshot(authDir);
    expect(snapshot.authAgeMs).toBeTypeOf("number");
    expect(snapshot.authAgeMs).toBeGreaterThanOrEqual(-1);
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

  it.runIf(process.platform !== "win32")(
    "treats symlinked creds as missing across auth readers",
    async () => {
      const authDir = tempDirs.make("openclaw-wa-auth-symlink-read-");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      fsSync.writeFileSync(
        targetPath,
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetPath, credsPath);

      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.statSync(credsPath).isFile()).toBe(true);
      expect(hasWebCredsSync(authDir)).toBe(false);
      expect(readCredsJsonRaw(credsPath)).toBeNull();
      expect(getWebAuthAgeMs(authDir)).toBeNull();
      expect(readWebSelfId(authDir)).toEqual({ e164: null, jid: null, lid: null });
      await expect(readWebSelfIdentity(authDir)).resolves.toEqual({
        e164: null,
        jid: null,
        lid: null,
      });
      await expect(webAuthExists(authDir)).resolves.toBe(false);
      await expect(readWebAuthState(authDir)).resolves.toBe("not-linked");
      await expect(readWebAuthSnapshot(authDir)).resolves.toEqual({
        state: "not-linked",
        authAgeMs: null,
        selfId: { e164: null, jid: null, lid: null },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats creds under a symlinked auth directory as missing",
    async () => {
      const rootDir = tempDirs.make("openclaw-wa-auth-symlink-parent-");
      const targetAuthDir = path.join(rootDir, "target-auth");
      const authDir = path.join(rootDir, "linked-auth");
      fsSync.mkdirSync(targetAuthDir);
      fsSync.writeFileSync(
        path.join(targetAuthDir, "creds.json"),
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetAuthDir, authDir, "dir");
      const credsPath = path.join(authDir, "creds.json");

      expect(fsSync.lstatSync(authDir).isSymbolicLink()).toBe(true);
      expect(fsSync.lstatSync(credsPath).isFile()).toBe(true);
      expect(hasWebCredsSync(authDir)).toBe(false);
      expect(readCredsJsonRaw(credsPath)).toBeNull();
      await expect(webAuthExists(authDir)).resolves.toBe(false);
      await expect(readWebAuthState(authDir)).resolves.toBe("not-linked");
    },
  );

  it("reports unstable auth state when the shared barrier read times out", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-unstable-state-");
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

  it("revalidates setup ownership immediately before deleting linked credentials", async () => {
    await withOwnedOAuthAuthDir("openclaw-wa-auth-guarded-logout", async (authDir) => {
      const credsPath = path.join(authDir, "creds.json");
      const guardError = new Error("verified inference route changed");
      fsSync.writeFileSync(credsPath, "{}", "utf-8");

      await expect(
        logoutWeb({
          authDir,
          beforeCredentialPersistence: async () => {
            throw guardError;
          },
        }),
      ).rejects.toBe(guardError);
      expect(fsSync.existsSync(credsPath)).toBe(true);
    });
  });

  it("does not delete the whole legacy auth root when targeted cleanup fails", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-legacy-failure-");
    const previousOAuthDir = hoisted.oauthDir;
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

    try {
      hoisted.oauthDir = authDir;
      await expect(
        logoutWeb({ authDir, isLegacyAuthDir: true, runtime: runtime as never }),
      ).rejects.toThrow("EACCES");
      expect(fsSync.existsSync(authDir)).toBe(true);
      expect(fsSync.existsSync(path.join(authDir, "oauth.json"))).toBe(true);
    } finally {
      hoisted.oauthDir = previousOAuthDir;
      rmSpy.mockRestore();
    }
  });

  it("clears every Baileys auth category from the shared legacy root without touching other files", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-legacy-categories-");
    const previousOAuthDir = hoisted.oauthDir;
    const authFiles = [
      "creds.json",
      "creds.json.bak",
      "pre-key-1.json",
      "session-contact.json",
      "sender-key-group.json",
      "sender-key-memory-group.json",
      "app-state-sync-key-contact.json",
      "app-state-sync-version-contact.json",
      "lid-mapping-15551234567.json",
      "device-list-15551234567.json",
      "tctoken-15551234567.json",
      "identity-key-15551234567.json",
    ];
    const unrelatedFiles = ["oauth.json", "google-oauth.json", "notes.txt"];
    const nestedAuthFile = path.join(authDir, "nested", "session-keep.json");
    hoisted.oauthDir = authDir;

    try {
      for (const file of [...authFiles, ...unrelatedFiles]) {
        fsSync.writeFileSync(path.join(authDir, file), "{}", "utf-8");
      }
      fsSync.mkdirSync(path.dirname(nestedAuthFile));
      fsSync.writeFileSync(nestedAuthFile, "keep", "utf-8");
      fsSync.symlinkSync(
        path.join(authDir, "notes.txt"),
        path.join(authDir, "session-linked.json"),
      );

      await expect(logoutWeb({ authDir, isLegacyAuthDir: true })).resolves.toBe(true);

      for (const file of authFiles) {
        expect(fsSync.existsSync(path.join(authDir, file)), file).toBe(false);
      }
      for (const file of unrelatedFiles) {
        expect(fsSync.existsSync(path.join(authDir, file)), file).toBe(true);
      }
      expect(fsSync.readFileSync(nestedAuthFile, "utf-8")).toBe("keep");
      expect(fsSync.lstatSync(path.join(authDir, "session-linked.json")).isSymbolicLink()).toBe(
        true,
      );
    } finally {
      hoisted.oauthDir = previousOAuthDir;
    }
  });

  it("does not delete unrelated non-empty directories on logout", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-unrelated-");
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
