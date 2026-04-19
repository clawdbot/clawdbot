import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundSendDep, sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveSendableOutboundReplyParts,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import { shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
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

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = resolveSendableOutboundReplyParts(ctx.payload).hasMedia;
    if (!text && !hasMedia) {
      return createEmptyChannelResult("whatsapp");
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
  ...createAttachedChannelResultAdapter({
    channel: "whatsapp",
    sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
      const normalizedText = trimLeadingWhitespace(text);
      if (!normalizedText) {
        return createEmptyChannelResult("whatsapp");
      }
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp", {
          legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
        }) ?? (await loadWhatsAppSendModule()).sendMessageWhatsApp;
      return await send(to, normalizedText, {
        verbose: false,
        cfg,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      gifPlayback,
    }) => {
      const normalizedText = trimLeadingWhitespace(text);
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp", {
          legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
        }) ?? (await loadWhatsAppSendModule()).sendMessageWhatsApp;
      return await send(to, normalizedText, {
        verbose: false,
        cfg,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId }) =>
      await (
        await loadWhatsAppSendModule()
      ).sendPollWhatsApp(to, poll, {
        verbose: shouldLogVerbose(),
        accountId: accountId ?? undefined,
        cfg,
      }),
  }),
};
