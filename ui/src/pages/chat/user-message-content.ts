// Control UI chat module implements user message content behavior.
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
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

function buildUserChatMessageContentBlocks(
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

type LocalUserMessageInput = {
  attachments?: readonly ChatAttachment[];
  createdAt: number;
  pending?: {
    error?: string;
    id: string;
    state?: string;
  };
  replyToId?: string;
  runId?: string;
  sender?: SenderIdentity;
  text: string;
};

type LocalUserMessage = {
  role: "user";
  content: UserChatMessageContentBlock[];
  timestamp: number;
  __openclaw: Record<string, unknown> & {
    idempotencyKey?: string;
  };
};

/** Canonical local user-turn projection shared by optimistic and acknowledged sends. */
export function buildLocalUserMessage(input: LocalUserMessageInput): LocalUserMessage | null {
  const content = buildUserChatMessageContentBlocks(input.text, input.attachments);
  if (content.length === 0) {
    return null;
  }
  return {
    role: "user",
    content,
    timestamp: input.createdAt,
    __openclaw: {
      ...(input.runId ? { idempotencyKey: `${input.runId}:user` } : {}),
      ...(input.pending
        ? {
            kind: "pending-send",
            id: input.pending.id,
            ...(input.pending.state ? { state: input.pending.state } : {}),
            ...(input.pending.error ? { error: input.pending.error } : {}),
          }
        : {}),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.sender?.id ? { senderId: input.sender.id } : {}),
      ...(input.sender?.identity ? { senderIdentity: input.sender.identity } : {}),
      ...(input.sender?.name ? { senderName: input.sender.name } : {}),
      ...(input.sender?.username ? { senderUsername: input.sender.username } : {}),
      ...(input.sender?.profileAvatarUrl
        ? { senderProfileAvatarUrl: input.sender.profileAvatarUrl }
        : {}),
    },
  };
}
