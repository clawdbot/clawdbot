// Control UI chat module implements attachment payload store behavior.
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

type AttachmentPayload = {
  dataUrl?: string;
  previewUrl?: string;
};

const payloads = new Map<string, AttachmentPayload>();

function createObjectUrl(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  return URL.createObjectURL(file);
}

function revokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}

export function registerChatAttachmentPayload(params: {
  attachment: ChatAttachment;
  dataUrl: string;
  file: File;
}): ChatAttachment {
  const previous = payloads.get(params.attachment.id);
  revokeObjectUrl(previous?.previewUrl);
  const objectUrl = createObjectUrl(params.file);
  const previewUrl = objectUrl ?? params.attachment.previewUrl;
  payloads.set(params.attachment.id, {
    dataUrl: params.dataUrl,
    ...(previewUrl ? { previewUrl } : {}),
  });
  return {
    ...params.attachment,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export function getChatAttachmentDataUrl(attachment: ChatAttachment): string | null {
  return attachment.dataUrl ?? payloads.get(attachment.id)?.dataUrl ?? null;
}

export function getChatAttachmentPreviewUrl(attachment: ChatAttachment): string | null {
  return (
    attachment.previewUrl ?? payloads.get(attachment.id)?.previewUrl ?? attachment.dataUrl ?? null
  );
}

function cloneChatAttachmentMetadata(attachment: ChatAttachment): ChatAttachment {
  const { dataUrl: _dataUrl, ...metadata } = attachment;
  return metadata;
}

export function cloneChatAttachmentsMetadata(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map(cloneChatAttachmentMetadata);
}

export function releaseChatAttachmentPayload(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  revokeObjectUrl(payload.previewUrl);
  payloads.delete(id);
}

export function releaseChatAttachmentPayloads(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    releaseChatAttachmentPayload(attachment.id);
  }
}

export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Same admission contract as the Swift/Android restore paths: only well-formed,
// size-bounded inline images come back; a corrupt transcript entry is skipped,
// never fatal. 5 MiB decoded matches the gateway media cap (MEDIA_MAX_BYTES).
const RESTORED_IMAGE_MIME = /^image\/[\w.+-]+$/u;
const RESTORED_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

// Iterative canonical-base64 check: the previous grouped-quantifier regex
// overflowed the V8 regex stack below RESTORED_ATTACHMENT_MAX_BASE64_CHARS,
// so restoring a large valid inline image threw RangeError (#90098).
function isCanonicalBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  let padding = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return false;
      }
      continue;
    }
    if (padding > 0) {
      return false;
    }
    const isBase64Char =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!isBase64Char) {
      return false;
    }
  }
  return true;
}

export function replaceChatAttachmentsFromEditor(
  current: readonly ChatAttachment[],
  restored: readonly { mimeType: string; data: string }[] = [],
): ChatAttachment[] {
  releaseChatAttachmentPayloads(current);
  return restored.flatMap(({ mimeType, data }) =>
    RESTORED_IMAGE_MIME.test(mimeType) &&
    data.length <= RESTORED_ATTACHMENT_MAX_BASE64_CHARS &&
    isCanonicalBase64Payload(data)
      ? [
          {
            id: generateAttachmentId(),
            mimeType,
            dataUrl: `data:${mimeType};base64,${data}`,
          },
        ]
      : [],
  );
}

function discardChatAttachmentDataUrl(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  if (payload.previewUrl) {
    payloads.set(id, { previewUrl: payload.previewUrl });
    return;
  }
  payloads.delete(id);
}

export function discardChatAttachmentDataUrls(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    discardChatAttachmentDataUrl(attachment.id);
  }
}
