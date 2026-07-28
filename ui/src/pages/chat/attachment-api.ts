import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

// Index/slice parsing only: a capture regex spanning a multi-megabyte payload
// can overflow the browser regex stack before chat.send staging runs (#90098).
function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex <= "data:".length || markerIndex + marker.length >= dataUrl.length) {
    return null;
  }
  return {
    mimeType: dataUrl.slice("data:".length, markerIndex),
    content: dataUrl.slice(markerIndex + marker.length),
  };
}

/** Converts composer attachments into the base64 payload accepted by chat.send. */
export function buildChatApiAttachments(attachments?: readonly ChatAttachment[]) {
  return attachments?.length
    ? attachments
        .map((attachment) => {
          const dataUrl = getChatAttachmentDataUrl(attachment);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: attachment.fileName,
            content: parsed.content,
          };
        })
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
    : undefined;
}

/** Restores durable first-turn payloads into visible, locked composer chips. */
export function restoreChatApiAttachments(attachments?: readonly unknown[]): ChatAttachment[] {
  if (!attachments?.length) {
    return [];
  }
  return attachments.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const attachment = value as Record<string, unknown>;
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const content = typeof attachment.content === "string" ? attachment.content : "";
    if (
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
    ) {
      return [];
    }
    return [
      {
        id: generateUUID(),
        dataUrl: `data:${mimeType};base64,${content}`,
        mimeType,
        fileName: typeof attachment.fileName === "string" ? attachment.fileName : undefined,
      },
    ];
  });
}
