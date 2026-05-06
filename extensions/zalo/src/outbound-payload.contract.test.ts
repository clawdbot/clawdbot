import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import { describe, expect, it, vi } from "vitest";
import { zaloMessageAdapter, zaloPlugin } from "./channel.js";

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

  it("declares message adapter durable text and media with receipt proofs", async () => {
    sendZaloTextMock.mockReset().mockImplementation(async (ctx: { mediaUrl?: string }) =>
      ctx.mediaUrl
        ? {
            ok: true,
            messageId: "zl-media-1",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "zalo", messageId: "zl-media-1" }],
              kind: "media",
            }),
          }
        : {
            ok: true,
            messageId: "zl-text-1",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "zalo", messageId: "zl-text-1" }],
              kind: "text",
            }),
          },
    );

    await expect(
      verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "zalo",
        adapter: zaloMessageAdapter,
        proofs: {
          text: async () => {
            const result = await zaloMessageAdapter.send?.text?.({
              cfg: {},
              to: "123456789",
              text: "hello",
            });
            expect(result?.receipt.platformMessageIds).toEqual(["zl-text-1"]);
          },
          media: async () => {
            const result = await zaloMessageAdapter.send?.media?.({
              cfg: {},
              to: "123456789",
              text: "image",
              mediaUrl: "https://example.com/image.png",
            });
            expect(result?.receipt.platformMessageIds).toEqual(["zl-media-1"]);
          },
          messageSendingHooks: () => {
            expect(zaloMessageAdapter.send?.text).toBeTypeOf("function");
          },
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "verified" },
        { capability: "messageSendingHooks", status: "verified" },
      ]),
    );
  });
});
