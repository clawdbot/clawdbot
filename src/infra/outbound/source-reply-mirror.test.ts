import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDeliveredCurrentSourceReply,
  reconcileTerminalSourceReplyDelivery,
} from "./source-reply-mirror.js";

const receiptMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  complete: vi.fn(),
}));
const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../../config/sessions/restart-recovery-receipt.js", () => ({
  beginRestartRecoveryTerminalDelivery: vi.fn(),
  cancelRestartRecoveryTerminalDelivery: receiptMocks.cancel,
  completeRestartRecoveryTerminalDelivery: receiptMocks.complete,
}));
vi.mock("../../channels/plugins/index.js", () => channelPluginMocks);

describe("reconcileTerminalSourceReplyDelivery", () => {
  const receipt = {
    sessionId: "session-1",
    sessionKey: "agent:main:discord:direct:user-1",
    sourceTurnId: "source-turn-1",
    storePath: "/tmp/sessions.json",
    toolCallId: "message-call-1",
  };
  const mirror = {
    action: "send",
    channel: "discord",
    actionParams: { target: "user-1", message: "answer" },
    cfg: {},
  };

  beforeEach(() => {
    receiptMocks.cancel.mockReset();
    receiptMocks.complete.mockReset();
    channelPluginMocks.getChannelPlugin.mockReset();
    channelPluginMocks.getLoadedChannelPlugin.mockReset();
  });

  it("cancels a receipt after an unambiguous explicit failure", async () => {
    await expect(
      reconcileTerminalSourceReplyDelivery({
        deliveredPayload: { ok: false, status: "failed" },
        mirror,
        receipt,
      }),
    ).resolves.toBe("not-delivered");

    expect(receiptMocks.cancel).toHaveBeenCalledWith(receipt);
    expect(receiptMocks.complete).not.toHaveBeenCalled();
  });

  it("keeps a receipt pending when an earlier gateway attempt was ambiguous", async () => {
    await expect(
      reconcileTerminalSourceReplyDelivery({
        deliveredPayload: { ok: false, status: "failed" },
        mirror,
        preservePendingOnExplicitFailure: true,
        receipt,
      }),
    ).resolves.toBe("pending");

    expect(receiptMocks.cancel).not.toHaveBeenCalled();
    expect(receiptMocks.complete).not.toHaveBeenCalled();
  });
});

describe("isDeliveredCurrentSourceReply", () => {
  it("matches a canonical Google Chat thread receipt to its inbound source thread", () => {
    const params = {
      action: "send",
      channel: "googlechat",
      actionParams: { target: "spaces/AAA", message: "answer" },
      cfg: {},
      sessionKey: "agent:main:googlechat:channel:spaces/AAA",
      toolContext: {
        currentChannelProvider: "googlechat",
        currentChannelId: "spaces/AAA",
        currentThreadTs: "spaces/AAA/threads/canonical",
      },
    };

    expect(
      isDeliveredCurrentSourceReply({
        ...params,
        deliveredPayload: {
          receipt: { threadId: "spaces/AAA/threads/canonical" },
        },
      }),
    ).toBe(true);
    expect(
      isDeliveredCurrentSourceReply({
        ...params,
        deliveredPayload: { receipt: { threadId: "spaces/AAA" } },
      }),
    ).toBe(false);
  });
});
