import {
  createStartAccountContext,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorTwitchProvider: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  monitorTwitchProvider: hoisted.monitorTwitchProvider,
}));

const { twitchPlugin } = await import("./plugin.js");

type TwitchStartAccount = NonNullable<NonNullable<typeof twitchPlugin.gateway>["startAccount"]>;

function requireStartAccount(): TwitchStartAccount {
  const startAccount = twitchPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("Expected Twitch gateway startAccount");
  }
  return startAccount;
}

function buildAccount(): TwitchAccountConfig & { accountId: string } {
  return {
    accountId: "default",
    username: "testbot",
    accessToken: "oauth:test-token",
    clientId: "test-client-id",
    channel: "#testchannel",
    enabled: true,
  };
}

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorTwitchProvider.mockResolvedValue({ stop });
  return stop;
}

function startTwitchAccount(abortSignal?: AbortSignal) {
  return requireStartAccount()(
    createStartAccountContext({
      account: buildAccount(),
      abortSignal,
    }),
  );
}

describe("twitch startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: requireStartAccount(),
      account: buildAccount(),
    });
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorTwitchProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startTwitchAccount(abort.signal);

    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
