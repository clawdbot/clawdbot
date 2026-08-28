// Matrix plugin module implements media text behavior.
import path from "node:path";
import {
  asNullableObjectRecord,
  asNullableRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  MatrixMessageAttachmentKind,
  MatrixMessageAttachmentSummary,
  MatrixRawEvent,
  RoomMessageEventContent,
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

export function resolveBundledMatrixReplacementContent(
  event: MatrixRawEvent,
): Partial<RoomMessageEventContent> | undefined {
  const replacement = asNullableObjectRecord(event.unsigned?.["m.relations"]?.["m.replace"]);
  if (!replacement || event.state_key !== undefined) {
    return undefined;
  }
  const content = asNullableObjectRecord(replacement.content);
  const relation = asNullableObjectRecord(content?.["m.relates_to"]);
  const newContent = content?.["m.new_content"];
  if (
    replacement.sender !== event.sender ||
    replacement.type !== event.type ||
    replacement.state_key !== undefined ||
    asNullableObjectRecord(replacement.unsigned)?.redacted_because ||
    !relation ||
    relation.rel_type !== "m.replace" ||
    relation.event_id !== event.event_id
  ) {
    return undefined;
  }
  return asNullableRecord(newContent) ?? undefined;
}

type MatrixMessageContentInput = {
  body?: string;
  filename?: string;
  msgtype?: string;
};

export function resolveMatrixMessageAttachment(
  params: MatrixMessageContentInput,
): MatrixMessageAttachmentSummary | undefined {
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

function formatMatrixAttachmentText(params: {
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
  filename?: string;
  msgtype?: string;
  tooLarge?: boolean;
  unavailable?: boolean;
}): string | undefined {
  const attachment = resolveMatrixMessageAttachment(params);
  const body = attachment ? (attachment.caption ?? "") : (params.body?.trim() ?? "");
  const marker = formatMatrixAttachmentText({
    attachment,
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

export function formatMatrixMediaUnavailableText(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): string {
  return formatMatrixMessageText({ ...params, unavailable: true }) ?? "";
}

export function formatMatrixMediaTooLargeText(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): string {
  return formatMatrixMessageText({ ...params, tooLarge: true }) ?? "";
}
