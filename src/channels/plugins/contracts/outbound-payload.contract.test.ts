import { describe, vi } from "vitest";
import { createDirectTextMediaOutbound } from "../outbound/direct-text-media.js";
import {
  installChannelOutboundPayloadContractSuite,
  type OutboundPayloadHarnessParams,
} from "./outbound-payload-testkit.js";
import { primeChannelOutboundSendMock } from "./test-helpers.js";

function createDirectTextMediaHarness(params: OutboundPayloadHarnessParams) {
  const sendFn = vi.fn();
  primeChannelOutboundSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "direct-text-media",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  const ctx = {
    cfg: {},
    to: "user1",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () => await outbound.sendPayload!(ctx),
    sendMock: sendFn,
    to: ctx.to,
  };
}

describe("outbound payload contracts", () => {
  describe("direct text/media", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "direct-text-media",
      chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
      createHarness: createDirectTextMediaHarness,
    });
  });
});
