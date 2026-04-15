import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { primeChannelOutboundSendMock } from "openclaw/plugin-sdk/testing";
import { vi, type Mock } from "vitest";
import { slackOutbound } from "./outbound-adapter.js";

type OutboundSendMock = Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;

type SlackOutboundPayloadHarness = {
  run: () => Promise<Record<string, unknown>>;
  sendMock: OutboundSendMock;
  to: string;
};

export function createSlackOutboundPayloadHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}): SlackOutboundPayloadHarness {
  const sendSlack: OutboundSendMock = vi.fn();
  primeChannelOutboundSendMock(
    sendSlack,
    { messageId: "sl-1", channelId: "C12345", ts: "1234.5678" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "C12345",
    text: "",
    payload: params.payload,
    deps: {
      sendSlack,
    },
  };
  return {
    run: async () => await slackOutbound.sendPayload!(ctx),
    sendMock: sendSlack,
    to: ctx.to,
  };
}
