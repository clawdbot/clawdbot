import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAPresence,
} from "@whiskeysockets/baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { isWhatsAppNewsletterJid } from "../normalize.js";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import { toWhatsappJid } from "../text-runtime.js";
import {
  addWhatsAppOutboundMentionsToContent,
  type WhatsAppOutboundMentionResolution,
} from "./outbound-mentions.js";
import {
  combineWhatsAppSendResults,
  normalizeWhatsAppSendResult,
  type WhatsAppSendResult,
} from "./send-result.js";
import type { ActiveWebSendOptions } from "./types.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (
      jid: string,
      content: AnyMessageContent,
      options?: MiscMessageGenerationOptions,
    ) => Promise<WAMessage | undefined>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  };
  defaultAccountId: string;
  resolveOutboundMentions?: (params: {
    jid: string;
    text: string;
  }) => Promise<WhatsAppOutboundMentionResolution> | WhatsAppOutboundMentionResolution;
}) {
  const resolveMentions = async (
    jid: string,
    text: string,
  ): Promise<WhatsAppOutboundMentionResolution> =>
    params.resolveOutboundMentions
      ? await params.resolveOutboundMentions({ jid, text })
      : { text, mentionedJids: [] };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<WhatsAppSendResult> => {
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      const shouldSendAudioText = Boolean(
        mediaBuffer && mediaType?.startsWith("audio/") && text.trim(),
      );
      const resolvedPayloadText = shouldSendAudioText
        ? { text, mentionedJids: [] }
        : await resolveMentions(jid, text);
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text: resolvedPayloadText.text };
      }
      payload = addWhatsAppOutboundMentionsToContent(payload, resolvedPayloadText.mentionedJids);
      const quotedOpts = buildQuotedMessageOptions({
        messageId: sendOptions?.quotedMessageKey?.id,
        remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
        fromMe: sendOptions?.quotedMessageKey?.fromMe,
        participant: sendOptions?.quotedMessageKey?.participant,
        messageText: sendOptions?.quotedMessageKey?.messageText,
      });
      const result = quotedOpts
        ? await params.sock.sendMessage(jid, payload, quotedOpts)
        : await params.sock.sendMessage(jid, payload);
      const results = [normalizeWhatsAppSendResult(result, mediaBuffer ? "media" : "text")];
      if (shouldSendAudioText) {
        const resolvedAudioText = await resolveMentions(jid, text);
        const textPayload = addWhatsAppOutboundMentionsToContent(
          { text: resolvedAudioText.text },
          resolvedAudioText.mentionedJids,
        );
        const textResult = quotedOpts
          ? await params.sock.sendMessage(jid, textPayload, quotedOpts)
          : await params.sock.sendMessage(jid, textPayload);
        results.push(normalizeWhatsAppSendResult(textResult, "text"));
      }
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      return combineWhatsAppSendResults(mediaBuffer ? "media" : "text", results);
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<WhatsAppSendResult> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      return normalizeWhatsAppSendResult(result, "poll");
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<WhatsAppSendResult> => {
      const jid = toWhatsappJid(chatJid);
      const result = await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
      return normalizeWhatsAppSendResult(result, "reaction");
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      if (isWhatsAppNewsletterJid(jid)) {
        return;
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
