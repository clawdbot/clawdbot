import { describe, expect, it, vi } from "vitest";
import { restartRunningChannelAccounts } from "./channel-thaw-restart.js";
import type { ChannelManager } from "./server-channels.js";

describe("restartRunningChannelAccounts", () => {
  it("rechecks admission before the timed-out stop recovery retry", async () => {
    let admissionOpen = true;
    let restartPending = true;
    const startChannel = vi.fn(async () => {
      admissionOpen = false;
      restartPending = true;
    });
    const manager = {
      getRuntimeSnapshot: () => ({
        channelAccounts: {
          discord: { default: { accountId: "default", running: false, restartPending } },
        },
      }),
      isManuallyStopped: () => false,
      stopChannel: vi.fn(),
      startChannel,
    } as unknown as Pick<
      ChannelManager,
      "getRuntimeSnapshot" | "isManuallyStopped" | "stopChannel" | "startChannel"
    >;

    await restartRunningChannelAccounts(manager, {
      shouldContinue: () => admissionOpen,
      onError: () => {},
    });

    expect(startChannel).toHaveBeenCalledTimes(1);
  });
});
