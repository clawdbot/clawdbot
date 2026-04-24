import { type ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

type WhatsAppSendModule = typeof import("./send.js");

let whatsAppSendModulePromise: Promise<WhatsAppSendModule> | undefined;

function loadWhatsAppSendModule(): Promise<WhatsAppSendModule> {
  whatsAppSendModulePromise ??= import("./send.js");
  return whatsAppSendModulePromise;
}

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = createWhatsAppOutboundBase({
  chunker: chunkText,
  sendMessageWhatsApp: async (to, text, options) =>
    await (
      await loadWhatsAppSendModule()
    ).sendMessageWhatsApp(to, trimLeadingWhitespace(text), {
      ...options,
    }),
  sendPollWhatsApp: async (to, poll, options) =>
    await (await loadWhatsAppSendModule()).sendPollWhatsApp(to, poll, options),
  shouldLogVerbose: () => shouldLogVerbose(),
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  normalizeText: trimLeadingWhitespace,
  skipEmptyText: true,
});
