import type { ChatAttachment } from "../ui-types.ts";
import { getChatAttachmentPreviewUrl } from "./attachment-payload-store.ts";

export type UserChatMessageContentBlock = {
  type: string;
  text?: string;
  url?: string;
  source?: unknown;
  attachment?: {
    url: string;
    kind: "audio" | "document";
    label: string;
    mimeType?: string;
  };
};

function isInlineDataUrl(value: string): boolean {
  return /^\s*data:/iu.test(value);
}

function formatInlineImageAttachmentPlaceholder(attachment: ChatAttachment): string {
  const label = attachment.fileName?.trim();
  return label ? `Attached image: ${label}` : "Attached image";
}

export function buildUserChatMessageContentBlocks(
  message: string,
  attachments?: readonly ChatAttachment[],
): UserChatMessageContentBlock[] {
  const blocks: UserChatMessageContentBlock[] = [];
  const text = message.trim();
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments ?? []) {
    const previewUrl = getChatAttachmentPreviewUrl(attachment);
    if (!previewUrl) {
      continue;
    }
    if (attachment.mimeType.startsWith("image/")) {
      if (isInlineDataUrl(previewUrl)) {
        blocks.push({ type: "text", text: formatInlineImageAttachmentPlaceholder(attachment) });
        continue;
      }
      blocks.push({
        type: "image",
        url: previewUrl,
        source: { type: "url", url: previewUrl },
      });
      continue;
    }
    blocks.push({
      type: "attachment",
      attachment: {
        url: previewUrl,
        kind: attachment.mimeType.startsWith("audio/") ? "audio" : "document",
        label: attachment.fileName?.trim() || "Attached file",
        mimeType: attachment.mimeType,
      },
    });
  }
  return blocks;
}
