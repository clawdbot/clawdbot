// Zalo tests cover outbound payload.contract plugin behavior.
import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createMessageReceiptFromOutboundResults,
  sendDurableMessageBatch,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloMessageAdapter, zaloPlugin } from "./channel.js";

const { sendZaloTextMock } = vi.hoisted(() => ({
  sendZaloTextMock: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  sendZaloText: sendZaloTextMock,
}));

type ZaloOutbound = NonNullable<typeof zaloPlugin.outbound>;
type ZaloSendPayload = NonNullable<ZaloOutbound["sendPayload"]>;
type ZaloMessageSender = NonNullable<typeof zaloMessageAdapter.send>;

function requireZaloSendPayload(): ZaloSendPayload {
  const sendPayload = zaloPlugin.outbound?.sendPayload;
  if (!sendPayload) {
    throw new Error("Expected Zalo outbound sendPayload");
  }
  return sendPayload;
}

function requireZaloTextSender(): NonNullable<ZaloMessageSender["text"]> {
  const text = zaloMessageAdapter.send?.text;
  if (!text) {
    throw new Error("Expected Zalo message adapter text sender");
  }
  return text;
}

function requireZaloMediaSender(): NonNullable<ZaloMessageSender["media"]> {
  const media = zaloMessageAdapter.send?.media;
  if (!media) {
    throw new Error("Expected Zalo message adapter media sender");
  }
  return media;
}

function requireZaloOutboundTextSender(): NonNullable<ZaloOutbound["sendText"]> {
  const sendText = zaloPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("Expected Zalo outbound text sender");
  }
  return sendText;
}

function createZaloHarness(params: OutboundPayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(
    sendZalo,
    { ok: true, messageId: "zl-1" },
    params.sendResults?.map((result) => ({ ok: true, ...result })),
  );
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
  const sendPayload = requireZaloSendPayload();
  return {
    run: async () => await sendPayload(ctx),
    sendMock: sendZalo,
    to: ctx.to,
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Zalo outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });

  it("throws legacy raw send failures at the typed delivery boundary", async () => {
    sendZaloTextMock.mockReset().mockResolvedValue({
      ok: false,
      error: "Zalo rejected the message",
      receipt: createMessageReceiptFromOutboundResults({ results: [], kind: "text" }),
    });

    await expect(
      requireZaloOutboundTextSender()({ cfg: {}, to: "123456789", text: "hello" }),
    ).rejects.toThrow("Zalo rejected the message");
  });

  it.each([
    { kind: "text", payload: { text: "hello" } },
    {
      kind: "media",
      payload: { text: "image", mediaUrl: "https://example.com/image.png" },
    },
  ] as const)(
    "reports $kind message-adapter failures to durable delivery",
    async ({ kind, payload }) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "zalo", source: "test", plugin: zaloPlugin }]),
      );
      sendZaloTextMock.mockReset().mockResolvedValue({
        ok: false,
        error: `Zalo rejected the ${kind}`,
        receipt: createMessageReceiptFromOutboundResults({ results: [], kind }),
      });

      const result = await sendDurableMessageBatch({
        cfg: {},
        channel: "zalo",
        to: "123456789",
        payloads: [payload],
        skipQueue: true,
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error(`Expected failed Zalo ${kind} delivery`);
      }
      expect(result.error).toMatchObject({ message: `Zalo rejected the ${kind}` });
    },
  );

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
    const sendText = requireZaloTextSender();
    const sendMedia = requireZaloMediaSender();

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "zalo",
      adapter: zaloMessageAdapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: {},
            to: "123456789",
            text: "hello",
          });
          expect(result.receipt.platformMessageIds).toEqual(["zl-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            cfg: {},
            to: "123456789",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result.receipt.platformMessageIds).toEqual(["zl-media-1"]);
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
    expect(proofs).toStrictEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "verified" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});
