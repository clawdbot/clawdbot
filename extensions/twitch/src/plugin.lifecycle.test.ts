// Twitch tests cover plugin.lifecycle plugin behavior.
import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
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
    withChannelRuntime(
      createStartAccountContext({
        account: buildAccount(),
        abortSignal,
      }),
    ),
  );
}

function withChannelRuntime(ctx: Parameters<TwitchStartAccount>[0]) {
  return { ...ctx, channelRuntime: createPluginRuntimeMock().channel };
}

describe("twitch startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: (ctx) => requireStartAccount()(withChannelRuntime(ctx)),
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

  it("publishes starting and forwards a bound status sink to the monitor", async () => {
    const stop = mockStartedMonitor();
    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();
    const task = requireStartAccount()(
      withChannelRuntime(
        createStartAccountContext({
          account: buildAccount(),
          abortSignal: abort.signal,
          statusPatchSink: (next) => patches.push({ ...next }),
        }),
      ),
    );

    await vi.waitFor(() => expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce());
    expectLifecyclePatch(patches, { lifecycle: "starting", running: true });
    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ statusSink: expect.any(Function) }),
    );

    abort.abort();
    await task;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startTwitchAccount(abort.signal);

    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("clears running status when monitor startup fails", async () => {
    hoisted.monitorTwitchProvider.mockRejectedValue(new Error("irc join failed"));
    const patches: ChannelAccountSnapshot[] = [];

    const task = requireStartAccount()(
      withChannelRuntime(
        createStartAccountContext({
          account: buildAccount(),
          statusPatchSink: (next) => patches.push({ ...next }),
        }),
      ),
    );

    await expect(task).rejects.toThrow("irc join failed");
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });

  it("rejects startup without its registered context builder", async () => {
    await expect(
      requireStartAccount()(createStartAccountContext({ account: buildAccount() })),
    ).rejects.toThrow("Twitch requires its registered channel runtime context builder");
    expect(hoisted.monitorTwitchProvider).not.toHaveBeenCalled();
  });
});
