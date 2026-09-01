// Control UI chat module implements user message content behavior.
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import { hasVideoMediaFileExtension } from "../../lib/media-file-extension.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "./attachment-payload-store.ts";

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
  retention?: "available" | "complete",
): UserChatMessageContentBlock[] | null {
  const blocks: UserChatMessageContentBlock[] = [];
  const text = message.trim();
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments ?? []) {
    // Retained content owns inline bytes before outbox cleanup releases Blob URLs.
    // Initial prompts allow available previews; delivered turns require every byte.
    const dataUrl = retention ? getChatAttachmentDataUrl(attachment) : undefined;
    if (retention === "complete" && !dataUrl) {
      return null;
    }
    const previewUrl = dataUrl || getChatAttachmentPreviewUrl(attachment);
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

/** Bind initial display bytes to their explicit submission, before releasing the draft. */
export function buildInitialChatSubmission(
  sessionKey: string,
  input: Pick<LocalUserMessageInput, "text" | "attachments" | "createdAt" | "sender">,
  owner: object,
  runId?: string,
) {
  const pendingRunId = runId?.trim();
  const message = pendingRunId
    ? buildLocalUserMessage({ ...input, runId: pendingRunId }, "available")
    : null;
  return message && pendingRunId
    ? { kind: "initial" as const, sessionKey, owner, pendingRunId, message }
    : null;
}

/** Canonical local user-turn projection shared by optimistic and acknowledged sends. */
export function buildLocalUserMessage(
  input: LocalUserMessageInput,
  retention?: "available" | "complete",
): LocalUserMessage | null {
  const content = buildUserChatMessageContentBlocks(input.text, input.attachments, retention);
  if (!content?.length) {
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
