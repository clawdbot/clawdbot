// Imessage tests cover test plugin plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyDurableFinalCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

type IMessageOutbound = NonNullable<ReturnType<typeof createIMessageTestPlugin>["outbound"]>;
type IMessageMessageAdapter = NonNullable<typeof imessagePlugin.message>;
type IMessageMessageSender = NonNullable<IMessageMessageAdapter["send"]>;

function requireOutbound(): IMessageOutbound {
  const outbound = createIMessageTestPlugin().outbound;
  if (!outbound) {
    throw new Error("Expected iMessage test plugin outbound adapter");
  }
  return outbound;
}

function requireOutboundSendText(
  outbound: IMessageOutbound,
): NonNullable<IMessageOutbound["sendText"]> {
  const sendText = outbound.sendText;
  if (!sendText) {
    throw new Error("Expected iMessage outbound sendText");
  }
  return sendText;
}

function requireOutboundSendMedia(
  outbound: IMessageOutbound,
): NonNullable<IMessageOutbound["sendMedia"]> {
  const sendMedia = outbound.sendMedia;
  if (!sendMedia) {
    throw new Error("Expected iMessage outbound sendMedia");
  }
  return sendMedia;
}

function requireMessageAdapter(): IMessageMessageAdapter {
  const adapter = imessagePlugin.message;
  if (!adapter) {
    throw new Error("Expected iMessage message adapter");
  }
  return adapter;
}

function requireMessageSendText(
  adapter: IMessageMessageAdapter,
): NonNullable<IMessageMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected iMessage message adapter text sender");
  }
  return text;
}

function requireMessageSendMedia(
  adapter: IMessageMessageAdapter,
): NonNullable<IMessageMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected iMessage message adapter media sender");
  }
  return media;
}

describe("createIMessageTestPlugin", () => {
  it("does not load the bundled iMessage facade by default", () => {
    expect(listImportedBundledPluginFacadeIds()).toStrictEqual([]);

    createIMessageTestPlugin();

    expect(listImportedBundledPluginFacadeIds()).toStrictEqual([]);
  });

  it("normalizes repeated transport prefixes without recursive stack growth", () => {
    const plugin = createIMessageTestPlugin();
    const prefixedHandle = `${"imessage:".repeat(5000)}+44 20 7946 0958`;

    expect(plugin.messaging?.normalizeTarget?.(prefixedHandle)).toBe("+442079460958");
  });

  it("declares durable final delivery capabilities", () => {
    expect(imessagePlugin.outbound?.deliveryCapabilities?.durableFinal).toStrictEqual({
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    });
    expect(createIMessageTestPlugin().outbound?.deliveryCapabilities?.durableFinal).toStrictEqual({
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    });
  });

  it("declares native iMessage voice memo TTS delivery", () => {
    expect(imessagePlugin.capabilities.tts?.voice).toStrictEqual({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
      preferAudioFileFormat: "caf",
    });
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = imessagePlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    if (!suppressor) {
      throw new Error("iMessage outbound approval suppressor unavailable");
    }

    expect(
      suppressor({
        cfg: {
          channels: {
            imessage: {
              enabled: true,
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:imessage:+15551230000",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
      }),
    ).toBe(true);
  });

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const outbound = requireOutbound();
    const sendText = requireOutboundSendText(outbound);
    const sendMedia = requireOutboundSendMedia(outbound);
    const sendIMessage = async () => ({ messageId: "imsg-1" });

    await verifyDurableFinalCapabilityProofs({
      adapterName: "imessageOutbound",
      capabilities: outbound.deliveryCapabilities?.durableFinal,
      proofs: {
        text: async () => {
          await expect(
            sendText({
              cfg: {} as never,
              to: "+15551234567",
              text: "hello",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        media: async () => {
          await expect(
            sendMedia({
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
            sendText({
              cfg: {} as never,
              to: "+15551234567",
              text: "reply",
              replyToId: "reply-1",
              deps: { imessage: sendIMessage },
            }),
          ).resolves.toEqual({ channel: "imessage", messageId: "imsg-1" });
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared message adapter capabilities with delivery proofs", async () => {
    const sendIMessage = async (
      _to: string,
      _text: string,
      opts?: { mediaUrl?: string; replyToId?: string; audioAsVoice?: boolean },
    ) => {
      const messageId = opts?.mediaUrl ? "imsg-media-1" : "imsg-text-1";
      return {
        messageId,
        sentText: opts?.mediaUrl ? "<media:image>" : "hello",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "imessage", messageId }],
          kind: opts?.audioAsVoice ? "voice" : opts?.mediaUrl ? "media" : "text",
          ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
        }),
      };
    };
    const adapter = requireMessageAdapter();
    const sendText = requireMessageSendText(adapter);
    const sendMedia = requireMessageSendMedia(adapter);

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "imessageMessage",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: {} as never,
            to: "+15551234567",
            text: "hello",
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendText>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            cfg: {} as never,
            to: "+15551234567",
            text: "caption",
            mediaUrl: "/tmp/image.png",
            mediaLocalRoots: ["/tmp"],
            audioAsVoice: true,
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendMedia>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.platformMessageIds).toEqual(["imsg-media-1"]);
          expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
        },
        replyTo: async () => {
          const result = await sendText({
            cfg: {} as never,
            to: "+15551234567",
            text: "reply",
            replyToId: "reply-1",
            deps: { imessage: sendIMessage },
          } as Parameters<typeof sendText>[0] & {
            deps: { imessage: typeof sendIMessage };
          });
          expect(result.receipt.replyToId).toBe("reply-1");
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("exposes seeded private API actions for binding contract tests", () => {
    const plugin = createIMessageTestPlugin();

    expect(plugin.actions?.describeMessageTool({} as never)?.actions).toStrictEqual([
      "react",
      "edit",
      "unsend",
      "reply",
      "sendWithEffect",
      "upload-file",
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
    ]);
  });
});
