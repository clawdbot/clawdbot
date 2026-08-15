import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClaudeCliCredentialsCached } from "./cli-credentials.js";

const execSyncMock = vi.fn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  execSyncMock.mockReset();
});

function readNonInteractiveClaudeCredential(platform: NodeJS.Platform) {
  let unreadable = false;
  const credential = readClaudeCliCredentialsCached({
    platform,
    homeDir: tempDirs.make("openclaw-claude-non-interactive-"),
    execSync: execSyncMock,
    allowKeychainPrompt: false,
    tryKeychainWithoutPrompt: true,
    ttlMs: 0,
    onStoredCredentialUnreadable: () => {
      unreadable = true;
    },
  });
  return { credential, unreadable };
}

function mockReadableKeychainCredential() {
  execSyncMock.mockReturnValue(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
}

it("reads an already-authorized Claude keychain credential during non-interactive setup", () => {
  mockReadableKeychainCredential();

  expect(readNonInteractiveClaudeCredential("darwin")).toEqual({
    credential: expect.objectContaining({
      type: "oauth",
      provider: "anthropic",
      refresh: "test-refresh",
    }),
    unreadable: false,
  });
  expect(execSyncMock).toHaveBeenCalledWith(
    expect.stringContaining(" -w"),
    expect.objectContaining({ timeout: 2_000 }),
  );
});

it("reports a present but unreadable Claude keychain credential", () => {
  execSyncMock.mockImplementation((command: string) => {
    if (command.includes(" -w")) {
      throw new Error("User interaction is not allowed");
    }
    return "keychain metadata";
  });

  expect(readNonInteractiveClaudeCredential("darwin")).toEqual({
    credential: null,
    unreadable: true,
  });
  expect(execSyncMock).toHaveBeenNthCalledWith(
    2,
    expect.not.stringContaining(" -w"),
    expect.objectContaining({ timeout: 2_000 }),
  );
});

it("reports missing Claude CLI auth when neither keychain nor file credentials exist", () => {
  execSyncMock.mockImplementation(() => {
    throw new Error("item not found");
  });

  expect(readNonInteractiveClaudeCredential("darwin")).toEqual({
    credential: null,
    unreadable: false,
  });
  expect(execSyncMock).toHaveBeenCalledTimes(2);
});

it("keeps non-darwin non-interactive Claude auth on the file path", () => {
  mockReadableKeychainCredential();

  expect(readNonInteractiveClaudeCredential("linux")).toEqual({
    credential: null,
    unreadable: false,
  });
  expect(execSyncMock).not.toHaveBeenCalled();
});
