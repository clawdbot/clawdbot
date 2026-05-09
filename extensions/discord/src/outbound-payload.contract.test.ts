import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, vi } from "vitest";
import { discordOutbound } from "./outbound-adapter.js";

type DiscordSendPayload = NonNullable<typeof discordOutbound.sendPayload>;

function requireDiscordSendPayload(): DiscordSendPayload {
  const sendPayload = discordOutbound.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected Discord outbound sendPayload");
  }
  return sendPayload;
}

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
  const sendPayload = requireDiscordSendPayload();
  return {
    run: async () => await sendPayload(ctx),
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
