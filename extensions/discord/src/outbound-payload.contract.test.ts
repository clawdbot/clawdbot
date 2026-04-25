import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/testing";
import { describe, vi } from "vitest";
import { discordOutbound } from "./outbound-adapter.js";

function createDiscordHarness(params: OutboundPayloadHarnessParams) {
  const sendDiscord = vi.fn();
  primeChannelOutboundSendMock(
    sendDiscord,
    { messageId: "dc-1", channelId: "123456" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: params.payload,
    deps: {
      sendDiscord,
    },
  };
  return {
    run: async () => await discordOutbound.sendPayload!(ctx),
    sendMock: sendDiscord,
    to: ctx.to,
  };
}

describe("Discord outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "discord",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createDiscordHarness,
  });
});
