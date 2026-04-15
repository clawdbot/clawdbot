import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "./send.js";

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

export const whatsappChannelOutbound = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp,
    sendPollWhatsApp,
    shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
    resolveTarget: ({ to, allowFrom, mode }) =>
      resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  }),
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppPayloadText(payload.text),
  }),
};
