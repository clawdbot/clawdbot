import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCommandBuffered = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered,
}));

const { readCodexCliActiveApiKeyAsync, readCodexCliCredentialsAsync } =
  await import("./cli-credentials.runtime.js");

const tempDirs: string[] = [];

function makeCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-keychain-reader-"));
  tempDirs.push(dir);
  return dir;
}

function commandResult(output: string, code = 0) {
  return {
    stdout: Buffer.from(output),
    stderr: Buffer.alloc(0),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

function jwtWithExpiry(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

beforeEach(() => {
  runCommandBuffered.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundled Codex Keychain credential reader", () => {
  it.runIf(process.platform !== "win32").each([
    {
      name: "canonicalizes a symlinked Codex home",
      arrange: () => {
        const target = makeCodexHome();
        const parent = makeCodexHome();
        const suppliedHome = path.join(parent, "codex-home");
        fs.symlinkSync(target, suppliedHome, "dir");
        return { suppliedHome, accountHome: fs.realpathSync.native(suppliedHome) };
      },
    },
    {
      name: "uses the raw Codex home when it does not exist",
      arrange: () => {
        const suppliedHome = path.join(makeCodexHome(), "missing");
        return { suppliedHome, accountHome: suppliedHome };
      },
    },
  ])("$name", async ({ arrange }) => {
    const { suppliedHome, accountHome } = arrange();
    const accountHash = createHash("sha256").update(accountHome).digest("hex").slice(0, 16);
    const expectedAccount = `cli|${accountHash}`;
    const secret = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "keychain-refresh",
      },
    });
    runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv.includes(expectedAccount) ? commandResult(secret) : commandResult("", 44),
    );

    await expect(
      readCodexCliCredentialsAsync({
        codexHome: suppliedHome,
        allowKeychainPrompt: true,
        platform: "darwin",
      }),
    ).resolves.toMatchObject({ type: "oauth", refresh: "keychain-refresh" });
    expect(runCommandBuffered).toHaveBeenCalledOnce();
  });

  it("reads OAuth through the bounded process runtime", async () => {
    const codexHome = makeCodexHome();
    runCommandBuffered.mockResolvedValue(
      commandResult(
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: "keychain-refresh",
          },
        }),
      ),
    );

    await expect(
      readCodexCliCredentialsAsync({
        codexHome,
        allowKeychainPrompt: true,
        platform: "darwin",
      }),
    ).resolves.toMatchObject({ type: "oauth", refresh: "keychain-refresh" });
    expect(runCommandBuffered).toHaveBeenCalledOnce();
  });

  it("shares one deadline across API-key status and Keychain reads", async () => {
    const codexHome = makeCodexHome();
    runCommandBuffered
      .mockResolvedValueOnce(commandResult("Logged in using an API key - keychain***i-key"))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "keychain-api-key" })),
      );

    await expect(
      readCodexCliActiveApiKeyAsync({
        codexHome,
        allowKeychainPrompt: true,
        platform: "darwin",
      }),
    ).resolves.toEqual({ type: "api_key", provider: "openai", key: "keychain-api-key" });
    expect(runCommandBuffered).toHaveBeenCalledTimes(2);
    expect(runCommandBuffered.mock.calls[0]?.[1]?.signal).toBe(
      runCommandBuffered.mock.calls[1]?.[1]?.signal,
    );
  });
});
