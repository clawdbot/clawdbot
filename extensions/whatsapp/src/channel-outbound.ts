import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-message";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-media-contract.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "./send.js";

export function normalizeWhatsAppChannelPayloadText(text: string | undefined): string {
  return normalizeWhatsAppPayloadTextPreservingIndentation(text);
}

function normalizeWhatsAppChannelSendText(text: string | undefined): string {
  const normalized = normalizeWhatsAppChannelPayloadText(text);
  return normalized.trim() ? normalized : "";
}

export const whatsappChannelOutbound = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (to, text, options) =>
      await sendMessageWhatsApp(to, text, {
        ...options,
        preserveLeadingWhitespace: true,
      }),
    sendPollWhatsApp,
    shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
    resolveTarget: ({ to, allowFrom, mode }) =>
      resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
    normalizeText: normalizeWhatsAppChannelSendText,
  }),
  sendTextOnlyErrorPayloads: true,
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppChannelPayloadText(payload.text),
  }),
};

function toWhatsAppMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof whatsappChannelOutbound.sendText>>>,
  replyToId?: string | null,
): ChannelMessageSendResult {
  const source = result as typeof result & { toJid?: string };
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId
        ? [
            {
              channel: "whatsapp",
              messageId: result.messageId,
              toJid: source.toJid,
            },
          ]
        : [],
      kind: "text",
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) =>
      toWhatsAppMessageSendResult(
        await whatsappChannelOutbound.sendText!({
          ...ctx,
        }),
        ctx.replyToId,
      ),
  },
});
