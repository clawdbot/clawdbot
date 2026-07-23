import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
// Telegram-specific pre-dispatch repair for the shared message action paths.
// Keep this host-owned and private: it is not a Channel Plugin SDK contract.
import {
  hasLegacyInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
} from "../../interactive/payload.js";

const TELEGRAM_SEND_CONTENT_FIELDS = [
  "message",
  "text",
  "content",
  "SendMessage",
  "caption",
  "buffer",
  "media",
  "mediaUrl",
  "mediaUrls",
  "path",
  "filePath",
  "image",
  "fileUrl",
] as const;

const TELEGRAM_ATTACHMENT_MEDIA_FIELDS = [
  "media",
  "mediaUrl",
  "path",
  "filePath",
  "fileUrl",
  "url",
] as const;

function hasTelegramAttachmentMedia(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return false;
      }
      const record = attachment as Record<string, unknown>;
      return TELEGRAM_ATTACHMENT_MEDIA_FIELDS.some((field) => {
        const media = record[field];
        return typeof media === "string" && Boolean(media.trim());
      });
    })
  );
}

function hasTelegramSendContent(args: Record<string, unknown>): boolean {
  return (
    TELEGRAM_SEND_CONTENT_FIELDS.some((field) => {
      const value = args[field];
      if (typeof value === "string") {
        return Boolean(value.trim());
      }
      if (Array.isArray(value)) {
        return value.some((entry) => typeof entry === "string" && Boolean(entry.trim()));
      }
      return value != null && value !== false;
    }) ||
    hasTelegramAttachmentMedia(args.attachments) ||
    hasMessagePresentationBlocks(args.presentation) ||
    hasLegacyInteractiveReplyBlocks(args.interactive)
  );
}

export function normalizeTelegramMessageActionRequest(params: {
  channel: string;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  origin: "message-tool" | "direct";
}): { action: ChannelMessageActionName; args: Record<string, unknown> } {
  if (params.channel !== "telegram") {
    return { action: params.action, args: params.args };
  }
  if (
    params.origin !== "message-tool" ||
    params.action !== "send" ||
    !Object.hasOwn(params.args, "location") ||
    !hasTelegramSendContent(params.args)
  ) {
    return { action: params.action, args: params.args };
  }
  const { location: _ignoredActionScopedLocation, ...args } = params.args;
  return { action: "send", args };
}
