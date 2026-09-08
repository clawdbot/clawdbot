/**
 * Message normalization utilities for chat rendering.
 */

import { mediaKindFromMime } from "@openclaw/media-core/constants";
import {
  asFiniteNumber,
  asNonNegativeFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import {
  extractCanvasShortcodes,
  isCanvasBoardWidgetName,
} from "../../../../src/chat/canvas-render.js";
import { readTranscriptSenderIdentity } from "../../../../src/chat/sender-identity.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolBlockArgs,
} from "../../../../src/chat/tool-content.js";
import {
  isRelativeAssistantMediaReference,
  splitMediaFromOutput,
} from "../../../../src/media/parse.js";
import { getMediaFileExtension } from "../media-file-extension.ts";
import type { NormalizedMessage, MessageContentItem } from "./chat-types.ts";
import { projectImportedMessageForDisplay } from "./imported-message-display.ts";
import { normalizeAttachmentContentBlock } from "./message-normalizer-attachments.ts";
import { formatSenderLabel, normalizeSenderIdentity } from "./sender-label.ts";

// Keep legacy labels readable without treating their UUID suffix as profile evidence.
const OPAQUE_ID_LABEL_SUFFIX_RE =
  /\s+\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/iu;

type CanvasPreview = Extract<MessageContentItem, { type: "canvas" }>["preview"];
type MessageDelivery = { audioAsVoice?: true; replyToCurrent?: true; replyToId?: string };

export function canvasPreviewsMatch(
  first: Pick<CanvasPreview, "viewId" | "url">,
  second: Pick<CanvasPreview, "viewId" | "url">,
): boolean {
  return Boolean(
    (first.viewId && first.viewId === second.viewId) || (first.url && first.url === second.url),
  );
}

function readMessageDelivery(value: unknown): MessageDelivery | undefined {
  const delivery = asOptionalRecord(value);
  if (
    !delivery ||
    (delivery.audioAsVoice !== undefined && delivery.audioAsVoice !== true) ||
    (delivery.replyToCurrent !== undefined && delivery.replyToCurrent !== true)
  ) {
    return undefined;
  }
  return {
    audioAsVoice: delivery.audioAsVoice,
    replyToCurrent: delivery.replyToCurrent,
    replyToId: readStringField(delivery, "replyToId"),
  };
}

export function readMessageSenderSession(value: unknown): NormalizedMessage["senderSession"] {
  const source = asOptionalRecord(value);
  if (!source) {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(source.sessionKey);
  const agentId = normalizeOptionalString(source.agentId);
  return sessionKey || agentId
    ? {
        ...("sessionKey" in source ? { sessionKey } : {}),
        ...("agentId" in source ? { agentId } : {}),
      }
    : undefined;
}

function normalizeOmittedMediaContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "omitted_media" }> | null {
  if (
    item.type !== "image" ||
    item.omitted !== true ||
    normalizeOptionalString(item.url) !== undefined
  ) {
    return null;
  }
  const sizeBytes = asNonNegativeFiniteNumber(item.bytes);
  return {
    type: "omitted_media",
    media: {
      kind: "image",
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    },
  };
}

export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  if (["user", "assistant", "system"].includes(lower)) {
    return lower;
  }
  if (["toolresult", "tool_result", "tool", "function"].includes(lower)) {
    return "tool";
  }
  return role;
}

function hasToolMessageEnvelope(message: Record<string, unknown> | undefined): boolean {
  return (
    typeof message?.toolCallId === "string" ||
    typeof message?.tool_call_id === "string" ||
    typeof message?.toolUseId === "string" ||
    typeof message?.tool_use_id === "string" ||
    typeof message?.toolName === "string" ||
    typeof message?.tool_name === "string"
  );
}

export function resolveMessageRole(message: unknown): string {
  const m = asOptionalRecord(message);
  const content = m?.content;
  const hasToolContent =
    Array.isArray(content) &&
    content.some((value) => {
      const type = asOptionalRecord(value)?.type;
      return isToolResultContentType(type) || isToolCallContentType(type);
    });
  return hasToolContent || hasToolMessageEnvelope(m)
    ? "toolResult"
    : (readStringField(m, "role") ?? "unknown");
}

export function isToolResultMessage(message: unknown): boolean {
  const m = asOptionalRecord(message);
  const role = typeof m?.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}

export function isStandaloneToolMessageForDisplay(message: unknown): boolean {
  // Tool classification needs envelope fields, not parsed content or media.
  const m = asOptionalRecord(message);
  const role = typeof m?.role === "string" ? normalizeRoleForGrouping(m.role) : "unknown";
  return role === "tool" || hasToolMessageEnvelope(m);
}

export function readCanvasContentPreview(content: unknown): CanvasPreview | null {
  const item = asOptionalRecord(content);
  const preview = item?.type === "canvas" ? asOptionalRecord(item.preview) : undefined;
  if (
    !preview ||
    preview.kind !== "canvas" ||
    preview.surface === "tool_card" ||
    preview.render !== "url"
  ) {
    return null;
  }
  const result: CanvasPreview = { kind: "canvas", surface: "assistant_message", render: "url" };
  for (const key of ["title", "url", "viewId", "className", "style"] as const) {
    const value = readStringField(preview, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  const preferredHeight = asFiniteNumber(preview.preferredHeight);
  if (preferredHeight !== undefined) {
    result.preferredHeight = preferredHeight;
  }
  const sandbox = preview.sandbox;
  if (sandbox === "strict" || sandbox === "scripts") {
    result.sandbox = sandbox;
  }
  const boardWidgetName = preview.boardWidgetName;
  if (isCanvasBoardWidgetName(boardWidgetName)) {
    result.boardWidgetName = boardWidgetName;
  }
  const mcpApp = asOptionalRecord(preview.mcpApp);
  const viewId = readStringField(mcpApp, "viewId");
  if (viewId?.trim()) {
    result.mcpApp = { viewId };
    for (const key of [
      "serverName",
      "toolName",
      "uiResourceUri",
      "toolCallId",
      "originSessionKey",
    ] as const) {
      const value = readStringField(mcpApp, key);
      if (value !== undefined) {
        result.mcpApp[key] = value;
      }
    }
  }
  return result;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  m4a: "audio/mp4",
  m2a: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function mimeTypeFromUrl(url: string): string | undefined {
  const ext = getMediaFileExtension(url);
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function inferAttachmentKind(url: string): {
  kind: Extract<MessageContentItem, { type: "attachment" }>["attachment"]["kind"];
  mimeType?: string;
  label: string;
} {
  const mimeType = mimeTypeFromUrl(url);
  const inferredKind = mediaKindFromMime(mimeType);
  const kind =
    !inferredKind || inferredKind === "sticker" || inferredKind === "unknown"
      ? "document"
      : inferredKind;
  const label = (() => {
    try {
      if (/^https?:\/\//i.test(url)) {
        const parsed = new URL(url);
        const name = parsed.pathname.split("/").pop()?.trim();
        return name || parsed.hostname || url;
      }
    } catch {}
    const name = url.split(/[\\/]/).pop()?.trim();
    return name || url;
  })();
  return { kind, mimeType, label };
}

function coerceAudioContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  if (item.type !== "audio") {
    return null;
  }
  const source = asOptionalRecord(item.source);
  if (!source) {
    return null;
  }
  const rawMediaType = readStringField(source, "media_type")?.trim();
  const mediaType = rawMediaType?.toLowerCase().startsWith("audio/") ? rawMediaType : "audio/mpeg";
  const type = source.type;
  const data = readStringField(source, type === "base64" ? "data" : "url")?.trim();
  if (!data || (type !== "base64" && type !== "url")) {
    return null;
  }
  const url =
    type === "base64" && !data.startsWith("data:") ? `data:${mediaType};base64,${data}` : data;
  return {
    type: "attachment",
    attachment: {
      url,
      kind: "audio",
      label: readStringField(item, "label")?.trim() || "Audio",
      mimeType: mediaType,
      ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
    },
  };
}

function coerceManagedMediaContentBlock(
  item: Record<string, unknown>,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  const kind = item.type;
  const url = readStringField(item, "url")?.trim();
  if ((kind !== "audio" && kind !== "video") || !url) {
    return null;
  }
  const attachment: Extract<MessageContentItem, { type: "attachment" }>["attachment"] = {
    url,
    kind,
    label:
      readStringField(item, "fileName")?.trim() ||
      readStringField(item, "label")?.trim() ||
      (kind === "audio" ? "Audio" : "Video"),
  };
  for (const key of ["mimeType", "artifactId"] as const) {
    const value = readStringField(item, key);
    if (value !== undefined) {
      attachment[key] = value;
    }
  }
  if (kind === "audio" && item.isVoiceNote === true) {
    attachment.isVoiceNote = true;
  }
  const playback = item.playback;
  if (playback === "native" || playback === "transcode") {
    attachment.playback = playback;
  }
  for (const key of ["sizeBytes", "durationMs", "width", "height"] as const) {
    const value = asFiniteNumber(item[key]);
    const dimension = key === "width" || key === "height";
    if (value !== undefined && (dimension ? kind === "video" && value > 0 : value >= 0)) {
      attachment[key] = value;
    }
  }
  return { type: "attachment", attachment };
}

function mergeAdjacentTextItems(items: MessageContentItem[]): MessageContentItem[] {
  const merged: MessageContentItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (item.type === "text" && previous?.type === "text") {
      previous.text = [previous.text, item.text].filter((value) => value !== undefined).join("\n");
      continue;
    }
    merged.push(item);
  }
  return merged.filter((item) => item.type !== "text" || Boolean(item.text?.trim()));
}

export function stripMessageDisplayMetadataText(text: string): string {
  return stripInboundMetadata(text);
}

function stripMessageDisplayMetadata(items: MessageContentItem[]): MessageContentItem[] {
  return items
    .map((item) => {
      if (item.type !== "text" || typeof item.text !== "string") {
        return item;
      }
      return { ...item, text: stripMessageDisplayMetadataText(item.text) };
    })
    .filter((item) => item.type !== "text" || Boolean(item.text?.trim()));
}

function expandTextContent(
  text: string,
  delivery: MessageDelivery | undefined,
  projectedCanvasPreviews: readonly CanvasPreview[],
): {
  content: MessageContentItem[];
  audioAsVoice: boolean;
  replyTarget: NormalizedMessage["replyTarget"];
} {
  const extracted = extractCanvasShortcodes(text);
  const parsed = splitMediaFromOutput(extracted.text, { extractAudioDirectives: false });
  const parts: MessageContentItem[] = [];
  const audioAsVoice = delivery?.audioAsVoice === true;
  const replyToId = delivery?.replyToId?.trim();
  const replyTarget: NormalizedMessage["replyTarget"] = replyToId
    ? { kind: "id", id: replyToId }
    : delivery?.replyToCurrent === true
      ? { kind: "current" }
      : null;
  const segments = parsed.segments ?? [{ type: "text" as const, text: parsed.text }];

  for (const segment of segments) {
    if (segment.type === "media") {
      if (isRelativeAssistantMediaReference(segment.url)) {
        parts.push({ type: "text", text: `MEDIA:${segment.url}` });
        continue;
      }
      const inferred = inferAttachmentKind(segment.url);
      parts.push({
        type: "attachment",
        attachment: {
          url: segment.url,
          kind: inferred.kind,
          label: inferred.label,
          mimeType: inferred.mimeType,
        },
      });
      continue;
    }

    if (segment.text) {
      parts.push({ type: "text", text: segment.text });
    }
  }
  for (const preview of extracted.previews) {
    if (
      preview.surface !== "assistant_message" ||
      projectedCanvasPreviews.some((projected) => canvasPreviewsMatch(preview, projected))
    ) {
      continue;
    }
    parts.push({
      type: "canvas",
      preview: { ...preview, surface: "assistant_message" },
      rawText: null,
    });
  }

  const content = mergeAdjacentTextItems(
    parts.map((item) => {
      if (item.type === "attachment" && item.attachment.kind === "audio" && audioAsVoice) {
        return Object.assign({}, item, { attachment: { ...item.attachment, isVoiceNote: true } });
      }
      return item;
    }),
  );

  return {
    content:
      content.length > 0
        ? content
        : (parsed.mediaUrls ?? []).some(isRelativeAssistantMediaReference)
          ? (parsed.mediaUrls ?? [])
              .filter(isRelativeAssistantMediaReference)
              .map((url) => ({ type: "text" as const, text: `MEDIA:${url}` }))
          : replyTarget === null && !audioAsVoice && parsed.text.trim().length > 0
            ? [{ type: "text", text: parsed.text }]
            : [],
    audioAsVoice,
    replyTarget,
  };
}

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = asOptionalRecord(projectImportedMessageForDisplay(message)) ?? {};
  const role = resolveMessageRole(m);
  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const isAssistantMessage = role === "assistant";
  const delivery = isAssistantMessage ? readMessageDelivery(m.openclawDelivery) : undefined;
  // History's structured blocks retain sandbox and dashboard metadata that
  // an assistant shortcode cannot carry. Keep that representation when both exist.
  const projectedCanvasPreviews = (contentItems ?? []).flatMap((value) => {
    const preview = readCanvasContentPreview(value);
    return preview ? [preview] : [];
  });

  // Extract content
  let content: MessageContentItem[] = [];
  let audioAsVoice = false;
  let replyTarget: NormalizedMessage["replyTarget"] = null;

  if (typeof m.content === "string") {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.content, delivery, projectedCanvasPreviews);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.content }];
    }
  } else if (contentItems) {
    content = contentItems.flatMap((value) => {
      const item = asOptionalRecord(value);
      if (!item) {
        return [];
      }
      const omittedMedia = normalizeOmittedMediaContentBlock(item);
      if (omittedMedia) {
        return [omittedMedia];
      }
      const type = item.type;
      const text = readStringField(item, "text");
      if (type === "thinking") {
        const thinking = readStringField(item, "thinking");
        return thinking === undefined ? [] : [{ type, thinking }];
      }
      if (isAssistantMessage) {
        const managedMediaAttachment = coerceManagedMediaContentBlock(item);
        if (managedMediaAttachment) {
          return [managedMediaAttachment];
        }
        const audioAttachment = coerceAudioContentBlock(item);
        if (audioAttachment) {
          return [audioAttachment];
        }
      } else if (type === "audio") {
        return [];
      }
      if (type === "attachment" || type === "attachment_error") {
        return normalizeAttachmentContentBlock(item) ?? [];
      }
      if (type === "canvas") {
        const preview = readCanvasContentPreview(item);
        if (!preview) {
          return [];
        }
        return [
          {
            type: "canvas" as const,
            preview,
            rawText: readStringField(item, "rawText") ?? null,
          },
        ];
      }
      if (
        text !== undefined &&
        (type === "text" ||
          (role === "user" && type === "input_text") ||
          (role === "assistant" && (type === "input_text" || type === "output_text")))
      ) {
        if (isAssistantMessage) {
          const expanded = expandTextContent(text, delivery, projectedCanvasPreviews);
          audioAsVoice = audioAsVoice || expanded.audioAsVoice;
          if (expanded.replyTarget?.kind === "id") {
            replyTarget = expanded.replyTarget;
          } else if (expanded.replyTarget?.kind === "current" && replyTarget === null) {
            replyTarget = expanded.replyTarget;
          }
          return expanded.content;
        }
        return [
          {
            type: "text" as const,
            text,
            name: undefined,
            args: undefined,
          },
        ];
      }
      return [
        {
          type:
            (type as Extract<
              MessageContentItem,
              { type: "text" | "tool_call" | "tool_result" }
            >["type"]) || "text",
          text,
          name: item.name as string | undefined,
          args: resolveToolBlockArgs(item),
        },
      ];
    });
  } else if (typeof m.text === "string") {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.text, delivery, projectedCanvasPreviews);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.text }];
    }
  }

  const timestamp = asFiniteNumber(m.timestamp) ?? Date.now();
  const id = readStringField(m, "id");
  const openClawMeta = asOptionalRecord(m["__openclaw"]);
  const structuredReplyToId = readStringField(openClawMeta, "replyToId")?.trim() ?? "";
  if (structuredReplyToId) {
    replyTarget = { kind: "id", id: structuredReplyToId };
  }
  const replyPreviewRecord = asOptionalRecord(openClawMeta?.replyToPreview);
  const replyPreviewText = readStringField(replyPreviewRecord, "text")?.trim() ?? "";
  const replyPreviewSender = readStringField(replyPreviewRecord, "senderLabel")?.trim() ?? "";
  const identity = readTranscriptSenderIdentity(openClawMeta?.senderIdentity);
  const metaSender = normalizeSenderIdentity({
    identity,
    id: openClawMeta?.senderId,
    name: openClawMeta?.senderName,
    username: openClawMeta?.senderUsername,
    profileAvatarUrl:
      identity?.type === "profile" ? openClawMeta?.senderProfileAvatarUrl : undefined,
  });
  const rawLabel = readStringField(m, "senderLabel")?.trim() ?? "";
  const senderLabel = rawLabel
    ? rawLabel.replace(OPAQUE_ID_LABEL_SUFFIX_RE, "").trim()
    : formatSenderLabel(metaSender);
  const sender = metaSender ?? (senderLabel ? { name: senderLabel } : null);

  content = stripMessageDisplayMetadata(content);
  const senderSession = readMessageSenderSession(m.senderSession);

  return {
    role,
    content,
    timestamp,
    id,
    senderLabel,
    ...(senderSession ? { senderSession } : {}),
    ...(sender ? { sender } : {}),
    ...(audioAsVoice ? { audioAsVoice: true } : {}),
    ...(replyPreviewText
      ? {
          replyPreview: {
            text: replyPreviewText,
            ...(replyPreviewSender ? { senderLabel: replyPreviewSender } : {}),
          },
        }
      : {}),
    ...(replyTarget ? { replyTarget } : {}),
  };
}
