// Whatsapp plugin module implements outbound adapter behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadText } from "./outbound-media-contract.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

const loadWhatsAppSendModule = createLazyRuntimeModule(() => import("./send.js"));

function normalizeOutboundText(text: string | undefined): string {
  return normalizeWhatsAppPayloadText(text);
}

export const whatsappOutbound: ChannelOutboundAdapter = createWhatsAppOutboundBase({
  chunker: chunkText,
  sendMessageWhatsApp: async (to, text, options) =>
    await (
      await loadWhatsAppSendModule()
    ).sendMessageWhatsApp(to, normalizeOutboundText(text), {
      ...options,
    }),
  sendPollWhatsApp: async (to, poll, options) =>
    await (await loadWhatsAppSendModule()).sendPollWhatsApp(to, poll, options),
  shouldLogVerbose: () => shouldLogVerbose(),
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  normalizeText: normalizeOutboundText,
  skipEmptyText: true,
});
