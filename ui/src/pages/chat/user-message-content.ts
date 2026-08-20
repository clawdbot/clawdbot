// Control UI chat module implements user message content behavior.
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { hasVideoMediaFileExtension } from "../../lib/media-file-extension.ts";
import { getChatAttachmentPreviewUrl } from "./attachment-payload-store.ts";

type UserChatMessageContentBlock = {
  type: string;
  text?: string;
  url?: string;
  source?: unknown;
  attachment?: {
    url: string;
    kind: Extract<MediaKind, "audio" | "video" | "document">;
    label: string;
    mimeType?: string;
  };
};

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
      blocks.push({
        type: "image",
        url: previewUrl,
        source: { type: "url", url: previewUrl },
      });
      continue;
    }
    const normalizedMimeType = attachment.mimeType.trim().toLowerCase();
    const isVideo =
      normalizedMimeType.startsWith("video/") ||
      ((normalizedMimeType === "" || normalizedMimeType === "application/octet-stream") &&
        hasVideoMediaFileExtension(attachment.fileName ?? ""));
    blocks.push({
      type: "attachment",
      attachment: {
        url: previewUrl,
        kind: attachment.mimeType.startsWith("audio/") ? "audio" : isVideo ? "video" : "document",
        label: attachment.fileName?.trim() || "Attached file",
        mimeType: attachment.mimeType,
      },
    });
  }
  return blocks;
}
