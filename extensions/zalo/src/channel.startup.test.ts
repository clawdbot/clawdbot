import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorZaloProvider: vi.fn(),
  probeZalo: vi.fn(async () => ({
    ok: false as const,
    error: "probe failed",
    elapsedMs: 1,
  })),
}));

vi.mock("./monitor.js", () => {
  return {
    monitorZaloProvider: hoisted.monitorZaloProvider,
  };
});

vi.mock("./probe.js", () => {
  return {
    probeZalo: hoisted.probeZalo,
  };
});

vi.mock("./channel.runtime.js", () => ({
  probeZaloAccount: hoisted.probeZalo,
  startZaloGatewayAccount: async (ctx: {
    account: ResolvedZaloAccount;
    abortSignal: AbortSignal;
    setStatus: (patch: Partial<ResolvedZaloAccount>) => void;
  }) => {
    await hoisted.probeZalo();
    ctx.setStatus({ accountId: ctx.account.accountId });
    return await hoisted.monitorZaloProvider({
      token: ctx.account.token,
      account: ctx.account,
      abortSignal: ctx.abortSignal,
      useWebhook: false,
    });
  },
}));

import { zaloPlugin } from "./channel.js";

type ZaloGateway = NonNullable<typeof zaloPlugin.gateway>;
type ZaloStartAccount = NonNullable<ZaloGateway["startAccount"]>;

function requireStartAccount(): ZaloStartAccount {
  const startAccount = zaloPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("Expected Zalo gateway startAccount");
  }
  return startAccount;
}

function buildAccount(): ResolvedZaloAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: {},
  };
}

describe("zaloPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort", async () => {
    hoisted.monitorZaloProvider.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: requireStartAccount(),
      account: buildAccount(),
    });

    await expectPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.probeZalo, hoisted.monitorZaloProvider),
      isSettled,
      abort,
      task,
    });

    expectLifecyclePatch(patches, { accountId: "default" });
    expect(isSettled()).toBe(true);
    expect(hoisted.monitorZaloProvider).toHaveBeenCalledTimes(1);
    const [monitorArgs] = hoisted.monitorZaloProvider.mock.calls[0] ?? [];
    expect(monitorArgs).toStrictEqual({
      token: "test-token",
      account: buildAccount(),
      abortSignal: abort.signal,
      useWebhook: false,
    });
  });
});
