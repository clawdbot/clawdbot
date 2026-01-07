import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
        [
          "telegram",
          "slack",
          "discord",
          "matrix",
          "signal",
          "imessage",
          "whatsapp",
        ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
  };
}

describe("dispatchReplyFromConfig", () => {
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    mocks.routeReply.mockClear();
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    };

    const replyResolver = async (
      _ctx: MsgContext,
      _opts: GetReplyOptions | undefined,
      _cfg: ClawdbotConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    mocks.routeReply.mockClear();
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    };

    const replyResolver = async (
      _ctx: MsgContext,
      _opts: GetReplyOptions | undefined,
      _cfg: ClawdbotConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
      }),
    );
  });
});
