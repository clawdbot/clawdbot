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

// Stored data URLs keep previews available when this browser cannot create object URLs.
export function getChatAttachmentPreviewUrl(attachment: ChatAttachment): string | null {
  const storedPreview = payloads.get(attachment.id)?.previewUrl;
  return attachment.previewUrl ?? storedPreview ?? getChatAttachmentDataUrl(attachment);
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

/** Gives another mounted composer payload ownership independent of the source. */
export function cloneChatAttachmentsForIndependentOwner(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map((attachment) => {
    const { id: _id, previewUrl: _previewUrl, ...metadata } = attachment;
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return { ...metadata, id: generateAttachmentId(), ...(dataUrl ? { dataUrl } : {}) };
  });
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

/**
 * Releases displaced attachments except ids still referenced by a retained
 * owner (live composer, surviving fallbacks). Attachments are backups of
 * composer state, so shared ids across owners are the norm — dropping one
 * owner must never revoke another owner's payload.
 */
export function releaseDisplacedChatAttachmentPayloads(
  displaced: readonly ChatAttachment[],
  retained: ReadonlyArray<readonly ChatAttachment[]>,
): void {
  const retainedIds = new Set(retained.flat().map((attachment) => attachment.id));
  releaseChatAttachmentPayloads(displaced.filter((attachment) => !retainedIds.has(attachment.id)));
}

export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Same admission contract as the Swift/Android restore paths: only well-formed,
// size-bounded inline images come back; a corrupt transcript entry is skipped,
// never fatal. 5 MiB decoded matches the gateway media cap (MEDIA_MAX_BYTES).
const RESTORED_IMAGE_MIME = /^image\/[\w.+-]+$/u;
const BASE64_PAYLOAD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const RESTORED_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export function replaceChatAttachmentsFromEditor(
  current: readonly ChatAttachment[],
  restored: readonly { mimeType: string; data: string }[] = [],
): ChatAttachment[] {
  releaseChatAttachmentPayloads(current);
  return restored.flatMap(({ mimeType, data }) =>
    RESTORED_IMAGE_MIME.test(mimeType) &&
    data.length > 0 &&
    data.length <= RESTORED_ATTACHMENT_MAX_BASE64_CHARS &&
    BASE64_PAYLOAD.test(data)
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
