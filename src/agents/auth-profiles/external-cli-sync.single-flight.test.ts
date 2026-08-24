/** Concurrent status requests must share one live CLI credential read. */
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const readClaudeCliCredentialsUncachedAsyncMock = vi.fn();

vi.mock("../cli-credentials.js", async (importActual) => {
  const actual = await importActual<typeof import("../cli-credentials.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsUncachedAsync: readClaudeCliCredentialsUncachedAsyncMock,
  };
});

const { listLiveExternalCliOwnedProfileIds } = await import("./external-cli-sync.js");

const PROFILE_ID = "anthropic:claude-cli";

function refreshFixture(): string {
  return ["stored", "refresh"].join("-");
}

function liveLogin() {
  return {
    type: "oauth",
    provider: "anthropic",
    access: ["stored", "access"].join("-"),
    refresh: refreshFixture(),
    expires: 1,
  };
}

/** Expired access token, refresh still present: the restart-persisted case. */
function expiredStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PROFILE_ID]: {
        type: "oauth",
        provider: "claude-cli",
        access: ["stored", "access"].join("-"),
        refresh: refreshFixture(),
        expires: 1,
      },
    },
  } as unknown as AuthProfileStore;
}

describe("live external cli ownership reads", () => {
  it("shares one in-flight credential read across concurrent lookups", async () => {
    readClaudeCliCredentialsUncachedAsyncMock.mockReset();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    readClaudeCliCredentialsUncachedAsyncMock.mockImplementation(async () => {
      await gate;
      return liveLogin();
    });

    const store = expiredStore();
    const both = Promise.all([
      listLiveExternalCliOwnedProfileIds(store),
      listLiveExternalCliOwnedProfileIds(store),
    ]);
    release?.();
    const [first, second] = await both;

    expect(first).toEqual([PROFILE_ID]);
    expect(second).toEqual([PROFILE_ID]);
    // Without coalescing each caller spawns its own bounded Keychain process.
    expect(readClaudeCliCredentialsUncachedAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a settled read, so a later logout is still reported", async () => {
    readClaudeCliCredentialsUncachedAsyncMock.mockReset();
    readClaudeCliCredentialsUncachedAsyncMock.mockResolvedValueOnce(liveLogin());
    readClaudeCliCredentialsUncachedAsyncMock.mockResolvedValueOnce(null);

    const store = expiredStore();

    await expect(listLiveExternalCliOwnedProfileIds(store)).resolves.toEqual([PROFILE_ID]);
    await expect(listLiveExternalCliOwnedProfileIds(store)).resolves.toEqual([]);
    expect(readClaudeCliCredentialsUncachedAsyncMock).toHaveBeenCalledTimes(2);
  });

  it("clears the shared entry when the read rejects", async () => {
    readClaudeCliCredentialsUncachedAsyncMock.mockReset();
    readClaudeCliCredentialsUncachedAsyncMock.mockRejectedValueOnce(new Error("keychain gone"));
    readClaudeCliCredentialsUncachedAsyncMock.mockResolvedValueOnce(liveLogin());

    const store = expiredStore();

    await expect(listLiveExternalCliOwnedProfileIds(store)).rejects.toThrow("keychain gone");
    // A failed read must not wedge every later lookup behind a rejected promise.
    await expect(listLiveExternalCliOwnedProfileIds(store)).resolves.toEqual([PROFILE_ID]);
  });
});
