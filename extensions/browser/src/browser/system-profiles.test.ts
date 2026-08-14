import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const profileMocks = vi.hoisted(() => ({
  managedUserDataDir: "",
  cookiesSetManyViaPlaywright: vi.fn(async (params: { cookies: unknown[] }) => ({
    added: params.cookies.length,
  })),
}));

vi.mock("./chrome.js", () => ({
  resolveOpenClawUserDataDir: () => profileMocks.managedUserDataDir,
}));

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => ({
    cookiesSetManyViaPlaywright: profileMocks.cookiesSetManyViaPlaywright,
  })),
}));

vi.mock("./server-context.js", () => ({
  runProfileContextOperation: async (
    _profile: unknown,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal, runtime: { running: { userDataDir: string } }) => Promise<unknown>,
    options?: { commit?: (result: unknown) => Promise<void> },
  ) => {
    const result = await run(signal ?? new AbortController().signal, {
      running: { userDataDir: profileMocks.managedUserDataDir },
    });
    await options?.commit?.(result);
    return result;
  },
}));

const { readSystemProfileCookies } = await import("../system-profile-api.js");
const { importSystemProfileCookies } = await import("./system-profiles.js");

const KEYCHAIN_FIXTURE = "fixture-value";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function encryptV10(value: string, host: string): Buffer {
  const key = crypto.pbkdf2Sync(KEYCHAIN_FIXTURE, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([
    crypto.createHash("sha256").update(host).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function createSystemProfileFixture(): string {
  const homeDir = tempDirs.make("openclaw-system-profile-test-");
  const root = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  const profileDir = path.join(root, "Default", "Network");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }),
  );
  const database = new DatabaseSync(path.join(profileDir, "Cookies"));
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE cookies (
        host_key TEXT,
        top_frame_site_key TEXT,
        name TEXT,
        value TEXT,
        encrypted_value BLOB,
        path TEXT,
        expires_utc INTEGER,
        is_secure INTEGER,
        is_httponly INTEGER,
        has_expires INTEGER,
        samesite INTEGER
      )
    `);
    const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [host, name, value] of [
      [".example.com", "session", "allowed-value"],
      [".other.test", "other", "blocked-value"],
    ] as const) {
      insert.run(host, "", name, "", encryptV10(value, host), "/", 0, 1, 1, 0, -1);
    }
  } finally {
    database.close();
  }
  return homeDir;
}

function createManagedProfileFixture() {
  profileMocks.managedUserDataDir = tempDirs.make("openclaw-managed-profile-test-");
  fs.writeFileSync(
    path.join(profileMocks.managedUserDataDir, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { openclaw_mock_keychain: true } } },
    }),
  );
  const profile = {
    name: "imported",
    driver: "openclaw" as const,
    cdpUrl: "http://127.0.0.1:18800",
    cdpIsLoopback: true,
    attachOnly: false,
  };
  return {
    ctx: {
      state: () => ({ resolved: { profiles: { imported: profile } } }),
      forProfile: () => ({
        profile,
        ensureBrowserAvailable: vi.fn(async () => {}),
        ensureTabAvailable: vi.fn(async () => ({ targetId: "tab-1" })),
      }),
    },
    createProfile: vi.fn(async () => {}),
  };
}

describe("system profile cookie reader", () => {
  beforeEach(() => {
    profileMocks.cookiesSetManyViaPlaywright.mockClear();
  });

  it("snapshots, decrypts, and applies the domain allowlist", async () => {
    const homeDir = createSystemProfileFixture();
    const readSecret = vi.fn(async () => Buffer.from(KEYCHAIN_FIXTURE));

    const result = await readSystemProfileCookies(
      { browser: "chrome", systemProfile: "Default", domains: ["example.com"] },
      { platform: "darwin", homeDir, readSecret },
    );

    expect(result).toMatchObject({
      browser: "chrome",
      systemProfile: "Default",
      counts: { total: 2, imported: 1, failed: 0, skipped: 1 },
      domains: [".example.com"],
    });
    expect(result.cookies).toEqual([
      expect.objectContaining({
        name: "session",
        value: "allowed-value",
        domain: ".example.com",
      }),
    ]);
    expect(readSecret).toHaveBeenCalledOnce();
  });

  it("keeps the existing import flow on the shared reader", async () => {
    const homeDir = createSystemProfileFixture();
    const runtime = createManagedProfileFixture();

    const result = await importSystemProfileCookies(
      { browser: "chrome", systemProfile: "Default", into: "imported", domains: ["example.com"] },
      runtime as never,
      {
        platform: "darwin",
        homeDir,
        cfg: { browser: {} },
        readSecret: async () => Buffer.from(KEYCHAIN_FIXTURE),
      },
    );

    expect(result.cookies).toEqual({ total: 2, imported: 1, failed: 0, skipped: 1 });
    expect(profileMocks.cookiesSetManyViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18800",
        targetId: "tab-1",
        cookies: [expect.objectContaining({ domain: ".example.com", name: "session" })],
      }),
    );
  });
});
