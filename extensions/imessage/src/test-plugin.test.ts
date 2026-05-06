import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyDurableFinalCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imessagePlugin } from "./channel.js";
import { createIMessageTestPlugin } from "./imessage.test-plugin.js";

beforeEach(() => {
  resetFacadeRuntimeStateForTest();
});

afterEach(() => {
  resetFacadeRuntimeStateForTest();
});

describe("createIMessageTestPlugin", () => {
  it("does not load the bundled iMessage facade by default", () => {
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    createIMessageTestPlugin();

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
  });

  it("normalizes repeated transport prefixes without recursive stack growth", () => {
    const plugin = createIMessageTestPlugin();
    const prefixedHandle = `${"imessage:".repeat(5000)}+44 20 7946 0958`;

    expect(plugin.messaging?.normalizeTarget?.(prefixedHandle)).toBe("+442079460958");
  });

  it("declares durable final delivery capabilities", () => {
    expect(imessagePlugin.outbound?.deliveryCapabilities?.durableFinal).toEqual(
      expect.objectContaining({
        text: true,
        media: true,
        replyTo: true,
        messageSendingHooks: true,
      }),
    );
    expect(createIMessageTestPlugin().outbound?.deliveryCapabilities?.durableFinal).toEqual(
      expect.objectContaining({
        text: true,
        media: true,
        replyTo: true,
        messageSendingHooks: true,
      }),
    );
  });

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const outbound = createIMessageTestPlugin().outbound!;
    const sendIMessage = async () => ({ messageId: "imsg-1" });

    await verifyDurableFinalCapabilityProofs({
      adapterName: "imessageOutbound",
      capabilities: outbound.deliveryCapabilities?.durableFinal,
      proofs: {
        text: async () => {
          await expect(
            outbound.sendText?.({
              cfg: {} as never,
              to: "+15551234567",
              text: "hello",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        media: async () => {
          await expect(
            outbound.sendMedia?.({
              cfg: {} as never,
              to: "+15551234567",
              text: "caption",
              mediaUrl: "/tmp/image.png",
              mediaLocalRoots: ["/tmp"],
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        replyTo: async () => {
          await expect(
            outbound.sendText?.({
              cfg: {} as never,
              to: "+15551234567",
              text: "reply",
              replyToId: "reply-1",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        messageSendingHooks: () => {
          expect(outbound.sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared message adapter capabilities with delivery proofs", async () => {
    const sendIMessage = async (
      _to: string,
      _text: string,
      opts?: { mediaUrl?: string; replyToId?: string },
    ) => {
      const messageId = opts?.mediaUrl ? "imsg-media-1" : "imsg-text-1";
      return {
        messageId,
        sentText: opts?.mediaUrl ? "<media:image>" : "hello",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "imessage", messageId }],
          kind: opts?.mediaUrl ? "media" : "text",
          ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
        }),
      };
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "imessageMessage",
      adapter: imessagePlugin.message!,
      proofs: {
        text: async () => {
          const result = await imessagePlugin.message?.send?.text?.({
            cfg: {} as never,
            to: "+15551234567",
            text: "hello",
            deps: { imessage: sendIMessage },
          } as Parameters<NonNullable<typeof imessagePlugin.message.send.text>>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result?.receipt.platformMessageIds).toEqual(["imsg-text-1"]);
        },
        media: async () => {
          const result = await imessagePlugin.message?.send?.media?.({
            cfg: {} as never,
            to: "+15551234567",
            text: "caption",
            mediaUrl: "/tmp/image.png",
            mediaLocalRoots: ["/tmp"],
            deps: { imessage: sendIMessage },
          } as Parameters<NonNullable<typeof imessagePlugin.message.send.media>>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result?.receipt.platformMessageIds).toEqual(["imsg-media-1"]);
        },
        replyTo: async () => {
          const result = await imessagePlugin.message?.send?.text?.({
            cfg: {} as never,
            to: "+15551234567",
            text: "reply",
            replyToId: "reply-1",
            deps: { imessage: sendIMessage },
          } as Parameters<NonNullable<typeof imessagePlugin.message.send.text>>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result?.receipt.replyToId).toBe("reply-1");
        },
        messageSendingHooks: () => {
          expect(imessagePlugin.message?.send?.text).toBeTypeOf("function");
        },
      },
    });
  });
});
