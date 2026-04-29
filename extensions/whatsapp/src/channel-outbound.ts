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
