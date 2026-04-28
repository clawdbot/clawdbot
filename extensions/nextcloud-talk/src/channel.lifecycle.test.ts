import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorNextcloudTalkProvider: vi.fn(),
}));

vi.mock("./monitor-runtime.js", () => ({
  monitorNextcloudTalkProvider: hoisted.monitorNextcloudTalkProvider,
}));

const { nextcloudTalkGatewayAdapter } = await import("./gateway.js");

function buildAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://nextcloud.example.com",
    secret: "secret", // pragma: allowlist secret
    secretSource: "config", // pragma: allowlist secret
    config: {
      baseUrl: "https://nextcloud.example.com",
      botSecret: "secret", // pragma: allowlist secret
      webhookPath: "/nextcloud-talk-webhook",
      webhookPort: 8788,
    },
  };
}

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorNextcloudTalkProvider.mockResolvedValue({ stop });
  return stop;
}

function startNextcloudAccount(abortSignal?: AbortSignal) {
  return nextcloudTalkGatewayAdapter.startAccount!(
    createStartAccountContext({
      account: buildAccount(),
      abortSignal,
    }),
  );
}

describe("nextcloud-talk startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: nextcloudTalkGatewayAdapter.startAccount!,
      account: buildAccount(),
    });
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorNextcloudTalkProvider),
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

    await startNextcloudAccount(abort.signal);

    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
