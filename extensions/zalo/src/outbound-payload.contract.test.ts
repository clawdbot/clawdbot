import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/testing";
import { describe, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

const { sendZaloTextMock } = vi.hoisted(() => ({
  sendZaloTextMock: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  sendZaloText: sendZaloTextMock,
}));

function createZaloHarness(params: OutboundPayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(sendZalo, { ok: true, messageId: "zl-1" }, params.sendResults);
  sendZaloTextMock.mockReset().mockImplementation(
    async (nextCtx: { to: string; text: string; mediaUrl?: string }) =>
      await sendZalo(nextCtx.to, nextCtx.text, {
        mediaUrl: nextCtx.mediaUrl,
      }),
  );
  const ctx = {
    cfg: {},
    to: "123456789",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () => await zaloPlugin.outbound!.sendPayload!(ctx),
    sendMock: sendZalo,
    to: ctx.to,
  };
}

describe("Zalo outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });
});
