/** Tests CLI credential parsing and cache expiry. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readClaudeCliCredentialsCached: typeof import("./cli-credentials.js").readClaudeCliCredentialsCached;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let resetCliCredentialCachesForTest: typeof import("./cli-credentials.js").resetCliCredentialCachesForTest;
let readCodexCliCredentials: typeof import("./cli-credentials.js").readCodexCliCredentials;
let readGeminiCliCredentialsCached: typeof import("./cli-credentials.js").readGeminiCliCredentialsCached;

async function readCachedClaudeCliCredentials(allowKeychainPrompt: boolean) {
  return readClaudeCliCredentialsCached({
    allowKeychainPrompt,
    ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
    platform: "darwin",
    execSync: execSyncMock,
  });
}

function createJwtWithExp(expSeconds: number): string {
  // Signature verification is out of scope; expiration extraction only needs a
  // syntactically valid JWT-like payload.
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
        subscriptionType: "max",
        rateLimitTier: "default_max_20x",
      },
    }),
  );
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  // Keeps large credential objects readable while still asserting exact fields
  // relevant to the branch under test.
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readClaudeCliCredentialsCached,
      readCodexCliCredentialsCached,
      resetCliCredentialCachesForTest,
      readCodexCliCredentials,
      readGeminiCliCredentialsCached,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    resetCliCredentialCachesForTest();
  });

  it.each([
    {
      name: "caches Claude Code CLI credentials within the TTL window",
      allowKeychainPromptSecondRead: true,
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

      if (!first || !second) {
        throw new Error("expected cached Claude CLI credentials to be available");
      }
      expectFields(first, {
        type: "oauth",
        provider: "anthropic",
        access: "token-1735689600000",
        refresh: "cached-refresh",
        subscriptionType: "max",
        rateLimitTier: "default_max_20x",
      });
      expectFields(second, {
        type: "oauth",
        provider: "anthropic",
        access: expectSameObject ? "token-1735689600000" : "token-1735690500001",
        refresh: "cached-refresh",
      });
      if (expectSameObject) {
        expect(second).toEqual(first);
      } else {
        expect(second).not.toEqual(first);
      }
      expect(execSyncMock).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("does not let no-keychain Claude cache misses poison keychain reads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-claude-cache-"));
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const withoutKeychain = readClaudeCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      homeDir: tempDir,
      execSync: execSyncMock,
    });

    expect(withoutKeychain).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();

    mockClaudeCliCredentialRead();
    const withKeychain = readClaudeCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      homeDir: tempDir,
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      type: "oauth",
      provider: "anthropic",
      refresh: "cached-refresh",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps no-prompt Claude reads on the file credential path after a keychain read", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-claude-cache-"));
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    mockClaudeCliCredentialRead();

    const withKeychain = readClaudeCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      homeDir: tempDir,
      execSync: execSyncMock,
    });
    const withoutPrompt = readClaudeCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      homeDir: tempDir,
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      type: "oauth",
      provider: "anthropic",
      refresh: "cached-refresh",
    });
    expect(withoutPrompt).toBeNull();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("reads Codex credentials from keychain when available", () => {
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

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "keychain-id-token",
    });
  });

  it("falls back when Codex keychain JWT expiry is outside Date range", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const lastRefresh = Date.parse("2026-01-01T00:00:00Z");
    const fallbackExpiry = lastRefresh + 60 * 60 * 1000;
    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentials({ platform: "darwin", execSync: execSyncMock });

    expectFields(creds, {
      refresh: "keychain-refresh",
      provider: "openai",
      expires: fallbackExpiry,
    });
  });

  it("rejects Codex keychain fallback expiry when the process clock is invalid", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const accountHash = "cli|";
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      execSyncMock.mockImplementation((command: unknown) => {
        const cmd = String(command);
        expect(cmd).toContain("Codex Auth");
        expect(cmd).toContain(accountHash);
        return JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(8_700_000_000_000),
            refresh_token: "keychain-refresh",
          },
        });
      });

      expect(readCodexCliCredentials({ platform: "darwin", execSync: execSyncMock })).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("falls back to Codex auth.json when keychain is unavailable", () => {
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

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "file-id-token",
    });
  });

  it("does not read stale Codex tokens when auth.json resolves to API-key mode", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-api-key-mode-"));
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
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-codex-api-key",
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "stale-file-refresh",
        },
      }),
      "utf8",
    );

    expect(readCodexCliCredentials({ platform: "linux", execSync: execSyncMock })).toBeNull();
  });

  it("treats an empty Codex auth.json API-key field as API-key mode", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-empty-api-key-mode-"));
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
        OPENAI_API_KEY: "",
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "stale-file-refresh",
        },
      }),
      "utf8",
    );

    expect(readCodexCliCredentials({ platform: "linux", execSync: execSyncMock })).toBeNull();
  });

  it("rejects Codex auth.json fallback expiry when stat and process clock are invalid", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-invalid-clock-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat unavailable");
    });
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(readCodexCliCredentials({ platform: "linux", execSync: execSyncMock })).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
      statSyncSpy.mockRestore();
    }
  });

  it("uses Codex auth.json fallback expiry when file mtime has fractional milliseconds", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-fractional-mtime-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const mtimeMs = Date.parse("2026-03-24T10:00:00Z") + 0.75;
    const statSyncSpy = vi.spyOn(fs, "statSync").mockReturnValue({ mtimeMs } as fs.Stats);
    try {
      const creds = readCodexCliCredentials({ platform: "linux", execSync: execSyncMock });

      expectFields(creds, {
        refresh: "file-refresh",
        provider: "openai",
        expires: Math.floor(mtimeMs) + 60 * 60 * 1000,
      });
    } finally {
      statSyncSpy.mockRestore();
    }
  });

  it("does not read Codex keychain when keychain prompts are disabled", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-no-prompt-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const creds = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
    });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("does not let no-keychain Codex cache misses poison keychain reads", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);

    const withoutKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });
    expect(withoutKeychain).toBeNull();

    execSyncMock.mockReturnValue(
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
      }),
    );
    const withKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps no-prompt Codex reads on auth.json after a keychain read", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const keychainExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const fileExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(fileExpiry),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockReturnValue(
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(keychainExpiry),
          refresh_token: "keychain-refresh",
        },
      }),
    );

    const withKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });
    const withoutPrompt = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      refresh: "keychain-refresh",
      expires: keychainExpiry * 1000,
      provider: "openai",
    });
    expectFields(withoutPrompt, {
      refresh: "file-refresh",
      expires: fileExpiry * 1000,
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
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

      expectFields(first, {
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

      expectFields(second, {
        refresh: "fresh-refresh",
        expires: secondExpiry * 1000,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("lifts Google account identity from the Gemini id_token", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gemini-"));
    try {
      const credPath = path.join(tempHome, ".gemini", "oauth_creds.json");
      fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
      const idTokenPayload = Buffer.from(
        JSON.stringify({ sub: "google-account-42", email: "user@example.com" }),
      ).toString("base64url");
      const idToken = `header.${idTokenPayload}.signature`;
      fs.writeFileSync(
        credPath,
        JSON.stringify({
          access_token: "gemini-access",
          refresh_token: "gemini-refresh",
          id_token: idToken,
          expiry_date: Date.parse("2026-04-25T12:00:00Z"),
        }),
        "utf8",
      );

      const creds = readGeminiCliCredentialsCached({ homeDir: tempHome, ttlMs: 0 });

      expectFields(creds, {
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh: "gemini-refresh",
        accountId: "google-account-42",
        email: "user@example.com",
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("reads Gemini credentials without identity fields when id_token is absent", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gemini-noid-"));
    try {
      const credPath = path.join(tempHome, ".gemini", "oauth_creds.json");
      fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        credPath,
        JSON.stringify({
          access_token: "gemini-access",
          refresh_token: "gemini-refresh",
          expiry_date: Date.parse("2026-04-25T12:00:00Z"),
        }),
        "utf8",
      );

      const creds = readGeminiCliCredentialsCached({ homeDir: tempHome, ttlMs: 0 });

      expectFields(creds, {
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh: "gemini-refresh",
      });
      expect(creds?.accountId).toBeUndefined();
      expect(creds?.email).toBeUndefined();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
