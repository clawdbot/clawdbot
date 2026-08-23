// Whatsapp tests cover outbound payload.contract plugin behavior.
import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyDurableFinalCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappMessageAdapter } from "./channel-outbound.js";
import { whatsappOutbound } from "./outbound-adapter.js";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-live-1", toJid: "jid-live" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-live-1", toJid: "jid-live" })),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

function createWhatsAppHarness(params: OutboundPayloadHarnessParams) {
  const sendWhatsApp = vi.fn();
  primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "5511999999999@c.us",
    text: "",
    payload: params.payload,
    deps: {
      whatsapp: sendWhatsApp,
    },
  };
  return {
    run: async () => await whatsappOutbound.sendPayload!(ctx),
    sendMock: sendWhatsApp,
    to: ctx.to,
  };
}

describe("WhatsApp outbound payload contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  installChannelOutboundPayloadContractSuite({
    channel: "whatsapp",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createWhatsAppHarness,
  });

  it("normalizes blank mediaUrls before contract delivery", async () => {
    const sendWhatsApp = vi.fn();
    primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1" });

    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: {
        text: "\n\ncaption",
        mediaUrls: ["   ", " /tmp/voice.ogg "],
      },
      deps: {
        whatsapp: sendWhatsApp,
      },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenCalledWith(
      "5511999999999@c.us",
      "caption",
      expect.objectContaining({
        verbose: false,
        cfg: {},
        mediaUrl: "/tmp/voice.ogg",
        mediaAccess: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        accountId: undefined,
        gifPlayback: undefined,
        onDeliveryResult: expect.any(Function),
      }),
    );
  });

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const sendWhatsApp = vi.fn();
    primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1", toJid: "jid-1" });

    const proveText = async () => {
      await whatsappOutbound.sendText!({
        cfg: {} as never,
        to: "5511999999999@c.us",
        text: " hello ",
        deps: { whatsapp: sendWhatsApp },
      });
      expect(sendWhatsApp).toHaveBeenLastCalledWith("5511999999999@c.us", "hello", {
        verbose: false,
        cfg: {},
        accountId: undefined,
        gifPlayback: undefined,
        quotedMessageKey: undefined,
      });
    };
    const proveReplyTo = async () => {
      await whatsappOutbound.sendText!({
        cfg: {} as never,
        to: "5511999999999@c.us",
        text: "reply",
        replyToId: "msg-1",
        deps: { whatsapp: sendWhatsApp },
      });
      expect(sendWhatsApp).not.toHaveBeenCalledWith(
        "5511999999999@c.us",
        "reply",
        expect.anything(),
      );
      expect(hoisted.sendMessageWhatsApp).toHaveBeenLastCalledWith("5511999999999@c.us", "reply", {
        verbose: false,
        cfg: {},
        accountId: undefined,
        gifPlayback: undefined,
        quotedMessageKey: {
          id: "msg-1",
          remoteJid: "5511999999999@c.us",
          fromMe: false,
          participant: undefined,
          messageText: undefined,
        },
      });
    };

    await verifyDurableFinalCapabilityProofs({
      adapterName: "whatsappOutbound",
      capabilities: whatsappOutbound.deliveryCapabilities?.durableFinal,
      proofs: {
        text: proveText,
        replyTo: proveReplyTo,
        messageSendingHooks: () => {
          expect(whatsappOutbound.sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared message adapter capabilities with delivery proofs", async () => {
    const sendWhatsApp = vi.fn();
    primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1", toJid: "jid-1" });

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "whatsappMessage",
      adapter: whatsappMessageAdapter,
      proofs: {
        text: async () => {
          const result = await whatsappMessageAdapter.send.text?.({
            cfg: {} as never,
            to: "5511999999999@c.us",
            text: "hello",
            deps: { whatsapp: sendWhatsApp },
          } as Parameters<NonNullable<typeof whatsappMessageAdapter.send.text>>[0] & {
            deps: { whatsapp: typeof sendWhatsApp };
          });
          expect(sendWhatsApp).toHaveBeenLastCalledWith("5511999999999@c.us", "hello", {
            verbose: false,
            cfg: {},
            accountId: undefined,
            gifPlayback: undefined,
            quotedMessageKey: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["wa-1"]);
        },
        replyTo: async () => {
          const result = await whatsappMessageAdapter.send.text?.({
            cfg: {} as never,
            to: "5511999999999@c.us",
            text: "reply",
            replyToId: "msg-1",
            deps: { whatsapp: sendWhatsApp },
          } as Parameters<NonNullable<typeof whatsappMessageAdapter.send.text>>[0] & {
            deps: { whatsapp: typeof sendWhatsApp };
          });
          expect(sendWhatsApp).not.toHaveBeenCalledWith(
            "5511999999999@c.us",
            "reply",
            expect.anything(),
          );
          expect(hoisted.sendMessageWhatsApp).toHaveBeenLastCalledWith(
            "5511999999999@c.us",
            "reply",
            {
              verbose: false,
              cfg: {},
              accountId: undefined,
              gifPlayback: undefined,
              quotedMessageKey: {
                id: "msg-1",
                remoteJid: "5511999999999@c.us",
                fromMe: false,
                participant: undefined,
                messageText: undefined,
              },
              preserveLeadingWhitespace: true,
            },
          );
          expect(result?.receipt.platformMessageIds).toEqual(["wa-live-1"]);
        },
        messageSendingHooks: () => {
          expect(whatsappMessageAdapter.send.text).toBeTypeOf("function");
        },
      },
    });
  });
});
