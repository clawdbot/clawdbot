import path from "node:path";
import type {
  MatrixMessageAttachmentKind,
  MatrixMessageAttachmentSummary,
  MatrixMessageSummary,
} from "./actions/types.js";

const MATRIX_MEDIA_KINDS: Record<string, MatrixMessageAttachmentKind> = {
  "m.audio": "audio",
  "m.file": "file",
  "m.image": "image",
  "m.sticker": "sticker",
  "m.video": "video",
};

function resolveMatrixMediaKind(msgtype: string | undefined): MatrixMessageAttachmentKind | null {
  return MATRIX_MEDIA_KINDS[msgtype ?? ""] ?? null;
}

function resolveMatrixMediaLabel(
  kind: MatrixMessageAttachmentKind | undefined,
  fallback = "media",
): string {
  return `${kind ?? fallback} attachment`;
}

function formatMatrixAttachmentMarker(params: {
  kind?: MatrixMessageAttachmentKind;
  tooLarge?: boolean;
  unavailable?: boolean;
}): string {
  const label = resolveMatrixMediaLabel(params.kind);
  if (params.tooLarge) {
    return `[matrix ${label} too large]`;
  }
  return params.unavailable ? `[matrix ${label} unavailable]` : `[matrix ${label}]`;
}

export function isLikelyBareFilename(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n") || /\s/.test(trimmed)) {
    return false;
  }
  if (path.basename(trimmed) !== trimmed) {
    return false;
  }
  return path.extname(trimmed).length > 1;
}

function resolveCaptionOrFilename(params: { body?: string; filename?: string }): {
  caption?: string;
  filename?: string;
} {
  const body = params.body?.trim() ?? "";
  const filename = params.filename?.trim() ?? "";
  if (filename) {
    if (!body || body === filename) {
      return { filename };
    }
    return { caption: body, filename };
  }
  if (!body) {
    return {};
  }
  if (isLikelyBareFilename(body)) {
    return { filename: body };
  }
  return { caption: body };
}

export function resolveMatrixMessageAttachment(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): MatrixMessageAttachmentSummary | undefined {
  const kind = resolveMatrixMediaKind(params.msgtype);
  if (!kind) {
    return undefined;
  }
  const resolved = resolveCaptionOrFilename(params);
  return {
    kind,
    caption: resolved.caption,
    filename: resolved.filename,
  };
}

export function resolveMatrixMessageBody(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): string | undefined {
  const attachment = resolveMatrixMessageAttachment(params);
  if (!attachment) {
    const body = params.body?.trim() ?? "";
    return body || undefined;
  }
  return attachment.caption;
}

export function formatMatrixAttachmentText(params: {
  attachment?: MatrixMessageAttachmentSummary;
  tooLarge?: boolean;
  unavailable?: boolean;
}): string | undefined {
  if (!params.attachment) {
    return undefined;
  }
  return formatMatrixAttachmentMarker({
    kind: params.attachment.kind,
    tooLarge: params.tooLarge,
    unavailable: params.unavailable,
  });
}

export function formatMatrixMessageText(params: {
  body?: string;
  attachment?: MatrixMessageAttachmentSummary;
  tooLarge?: boolean;
  unavailable?: boolean;
}): string | undefined {
  const body = params.body?.trim() ?? "";
  const marker = formatMatrixAttachmentText({
    attachment: params.attachment,
    tooLarge: params.tooLarge,
    unavailable: params.unavailable,
  });
  if (!marker) {
    return body || undefined;
  }
  if (!body) {
    return marker;
  }
  return `${body}\n\n${marker}`;
}

export function formatMatrixMessageSummaryText(
  summary: Pick<MatrixMessageSummary, "body" | "attachment">,
): string | undefined {
  return formatMatrixMessageText(summary);
}

export function formatMatrixMediaUnavailableText(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): string {
  return (
    formatMatrixMessageText({
      body: resolveMatrixMessageBody(params),
      attachment: resolveMatrixMessageAttachment(params),
      unavailable: true,
    }) ?? ""
  );
}

export function formatMatrixMediaTooLargeText(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): string {
  return (
    formatMatrixMessageText({
      body: resolveMatrixMessageBody(params),
      attachment: resolveMatrixMessageAttachment(params),
      tooLarge: true,
    }) ?? ""
  );
}
