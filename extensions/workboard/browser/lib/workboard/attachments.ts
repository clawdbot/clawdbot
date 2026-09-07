import type {
  WorkboardAttachment,
  WorkboardStagedAttachment,
  WorkboardStagedAttachmentPreview,
} from "./types.ts";

// These limits are part of the Workboard gateway contract. Keep the UI guard
// aligned so rejected files do not become oversized WebSocket payloads.
export const WORKBOARD_MAX_ATTACHMENT_BYTES = 256 * 1024;
export const WORKBOARD_MAX_CARD_ATTACHMENTS = 20;
export const WORKBOARD_MAX_ATTACHMENT_NAME_LENGTH = 240;
const WORKBOARD_STAGED_ATTACHMENT_BUSY_PREFIX = "staged:";

export function workboardStagedAttachmentBusyKey(id: string): string {
  return `${WORKBOARD_STAGED_ATTACHMENT_BUSY_PREFIX}${id}`;
}

export function hasWorkboardStagedAttachmentBusy(ids: ReadonlySet<string>): boolean {
  for (const id of ids) {
    if (id.startsWith(WORKBOARD_STAGED_ATTACHMENT_BUSY_PREFIX)) {
      return true;
    }
  }
  return false;
}

export type WorkboardAttachmentRejectionReason =
  | "empty"
  | "invalid_name"
  | "too_large"
  | "too_many";

export type WorkboardAttachmentRejection = {
  fileName: string;
  reason: WorkboardAttachmentRejectionReason;
};

export type StagedWorkboardAttachments = {
  accepted: WorkboardStagedAttachment[];
  rejected: WorkboardAttachmentRejection[];
};

let stagedAttachmentSequence = 0;

function nextStagedAttachmentId(): string {
  stagedAttachmentSequence += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `workboard-attachment-${Date.now()}-${stagedAttachmentSequence}`;
}

export function stageWorkboardAttachments(
  files: readonly File[],
  stagedCount: number,
): StagedWorkboardAttachments {
  const accepted: WorkboardStagedAttachment[] = [];
  const rejected: WorkboardAttachmentRejection[] = [];
  let available = Math.max(0, WORKBOARD_MAX_CARD_ATTACHMENTS - stagedCount);
  for (const file of files) {
    const fileName = file.name.trim();
    if (!fileName || fileName.length > WORKBOARD_MAX_ATTACHMENT_NAME_LENGTH) {
      rejected.push({ fileName: file.name, reason: "invalid_name" });
      continue;
    }
    if (file.size < 1) {
      rejected.push({ fileName: file.name, reason: "empty" });
      continue;
    }
    if (file.size > WORKBOARD_MAX_ATTACHMENT_BYTES) {
      rejected.push({ fileName: file.name, reason: "too_large" });
      continue;
    }
    if (available < 1) {
      rejected.push({ fileName: file.name, reason: "too_many" });
      continue;
    }
    accepted.push({
      id: nextStagedAttachmentId(),
      file,
      fileName,
      byteSize: file.size,
      ...(file.type ? { mimeType: file.type } : {}),
    });
    available -= 1;
  }
  return { accepted, rejected };
}

export async function encodeWorkboardAttachment(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}

export function formatWorkboardAttachmentBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kibibytes = bytes / 1024;
    return `${kibibytes >= 10 ? kibibytes.toFixed(0) : kibibytes.toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function workboardAttachmentMimeType(
  attachment: Pick<WorkboardAttachment, "mimeType">,
): string {
  const mimeType = attachment.mimeType?.trim();
  return mimeType &&
    /^[a-z][a-z0-9+.-]*\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:"[^"]*"|[a-z0-9!#$&^_.+-]+))*$/iu.test(
      mimeType,
    )
    ? mimeType
    : "application/octet-stream";
}

export function workboardAttachmentMediaType(
  attachment: Pick<WorkboardAttachment, "mimeType">,
): string {
  return workboardAttachmentMimeType(attachment).split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function workboardAttachmentDataUrl(
  attachment: Pick<WorkboardAttachment, "mimeType">,
  contentBase64: string,
): string {
  return `data:${workboardAttachmentMimeType(attachment)};base64,${contentBase64}`;
}

export function decodeWorkboardAttachmentText(contentBase64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

export function canPreviewWorkboardAttachment(attachment: Pick<WorkboardAttachment, "mimeType">) {
  const mimeType = workboardAttachmentMediaType(attachment);
  return (
    mimeType.startsWith("image/") || mimeType.startsWith("text/") || mimeType === "application/pdf"
  );
}

export async function prepareWorkboardStagedAttachmentPreview(
  file: File,
): Promise<WorkboardStagedAttachmentPreview> {
  const attachment = { mimeType: file.type };
  const mimeType = workboardAttachmentMediaType(attachment);
  const contentBase64 = await encodeWorkboardAttachment(file);
  if (mimeType.startsWith("image/")) {
    return { kind: "image", dataUrl: workboardAttachmentDataUrl(attachment, contentBase64) };
  }
  if (mimeType.startsWith("text/")) {
    const text = decodeWorkboardAttachmentText(contentBase64);
    return text === null ? { kind: "unavailable" } : { kind: "text", text };
  }
  if (mimeType === "application/pdf") {
    return { kind: "pdf", dataUrl: workboardAttachmentDataUrl(attachment, contentBase64) };
  }
  return { kind: "unavailable" };
}
