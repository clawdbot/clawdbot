/**
 * Message normalization utilities for chat rendering.
 */

import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { z } from "zod";
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
import { normalizeAttachmentContentBlock } from "./message-normalizer-attachments.ts";
import { formatSenderLabel, normalizeSenderIdentity } from "./sender-label.ts";

// Keep legacy labels readable without treating their UUID suffix as profile evidence.
const OPAQUE_ID_LABEL_SUFFIX_RE =
  /\s+\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/iu;

const optionalMessageStringSchema = z.string().optional().catch(undefined);
const optionalMessageNumberSchema = z.number().optional().catch(undefined);
const rawMcpAppSchema = z
  .looseObject({
    viewId: optionalMessageStringSchema,
    serverName: optionalMessageStringSchema,
    toolName: optionalMessageStringSchema,
    uiResourceUri: optionalMessageStringSchema,
    toolCallId: optionalMessageStringSchema,
    originSessionKey: optionalMessageStringSchema,
  })
  .optional()
  .catch(undefined);
const rawCanvasPreviewSchema = z
  .looseObject({
    title: optionalMessageStringSchema,
    preferredHeight: optionalMessageNumberSchema,
    url: optionalMessageStringSchema,
    viewId: optionalMessageStringSchema,
    className: optionalMessageStringSchema,
    style: optionalMessageStringSchema,
    mcpApp: rawMcpAppSchema,
  })
  .optional()
  .catch(undefined);
const rawAttachmentSchema = z
  .looseObject({
    code: optionalMessageStringSchema,
    kind: optionalMessageStringSchema,
    url: optionalMessageStringSchema,
    label: optionalMessageStringSchema,
    mimeType: optionalMessageStringSchema,
    artifactId: optionalMessageStringSchema,
    sizeBytes: optionalMessageNumberSchema,
    durationMs: optionalMessageNumberSchema,
    width: optionalMessageNumberSchema,
    height: optionalMessageNumberSchema,
  })
  .optional()
  .catch(undefined);
const rawAudioSourceSchema = z
  .looseObject({
    media_type: optionalMessageStringSchema,
    data: optionalMessageStringSchema,
    url: optionalMessageStringSchema,
  })
  .optional()
  .catch(undefined);
const rawContentBlockSchema = z.looseObject({
  text: optionalMessageStringSchema,
  source: rawAudioSourceSchema,
  attachment: rawAttachmentSchema,
  preview: rawCanvasPreviewSchema,
  rawText: optionalMessageStringSchema,
  label: optionalMessageStringSchema,
  fileName: optionalMessageStringSchema,
  mimeType: optionalMessageStringSchema,
  artifactId: optionalMessageStringSchema,
  url: optionalMessageStringSchema,
  sizeBytes: optionalMessageNumberSchema,
  durationMs: optionalMessageNumberSchema,
  width: optionalMessageNumberSchema,
  height: optionalMessageNumberSchema,
});
const rawContentBlocksSchema = z
  .array(z.union([rawContentBlockSchema, z.unknown().transform(() => null)]))
  .transform((items) =>
    items.filter((item): item is z.infer<typeof rawContentBlockSchema> => item !== null),
  );
const rawOpenClawMetadataSchema = z
  .looseObject({
    replyToId: optionalMessageStringSchema,
    replyToPreview: z
      .object({
        text: optionalMessageStringSchema,
        senderLabel: optionalMessageStringSchema,
      })
      .optional()
      .catch(undefined),
  })
  .optional()
  .catch(undefined);
const rawOpenClawDeliverySchema = z
  .object({
    audioAsVoice: z.literal(true).optional(),
    replyToCurrent: z.literal(true).optional(),
    replyToId: optionalMessageStringSchema,
  })
  .optional()
  .catch(undefined);
const rawMessageSchema = z
  .looseObject({
    role: optionalMessageStringSchema,
    content: z.union([z.string(), rawContentBlocksSchema]).optional().catch(undefined),
    text: optionalMessageStringSchema,
    timestamp: optionalMessageNumberSchema,
    id: optionalMessageStringSchema,
    senderLabel: optionalMessageStringSchema,
    senderSession: z
      .object({
        sessionKey: optionalMessageStringSchema.transform((value) => value?.trim() || undefined),
        agentId: optionalMessageStringSchema.transform((value) => value?.trim() || undefined),
      })
      .refine((value) => Boolean(value.sessionKey || value.agentId))
      .optional()
      .catch(undefined),
    toolCallId: optionalMessageStringSchema,
    tool_call_id: optionalMessageStringSchema,
    toolUseId: optionalMessageStringSchema,
    tool_use_id: optionalMessageStringSchema,
    toolName: optionalMessageStringSchema,
    tool_name: optionalMessageStringSchema,
    __openclaw: rawOpenClawMetadataSchema,
    openclawDelivery: rawOpenClawDeliverySchema,
  })
  .catch({});

type RawContentBlock = z.infer<typeof rawContentBlockSchema>;
type RawCanvasPreview = z.infer<typeof rawCanvasPreviewSchema>;

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

export function isToolResultMessage(message: unknown): boolean {
  const m = rawMessageSchema.parse(message);
  const role = m.role?.toLowerCase() ?? "";
  return role === "toolresult" || role === "tool_result";
}

export function isStandaloneToolMessageForDisplay(message: unknown): boolean {
  const m = rawMessageSchema.parse(message);
  const role = m.role ? normalizeRoleForGrouping(m.role) : "unknown";
  return (
    role === "tool" ||
    m.toolCallId !== undefined ||
    m.tool_call_id !== undefined ||
    m.toolUseId !== undefined ||
    m.tool_use_id !== undefined ||
    m.toolName !== undefined ||
    m.tool_name !== undefined
  );
}

function isTextContentBlock(
  item: RawContentBlock,
  role: string,
): item is RawContentBlock & { text: string } {
  return (
    item.text !== undefined &&
    (item.type === "text" ||
      (role === "user" && item.type === "input_text") ||
      (role === "assistant" && (item.type === "input_text" || item.type === "output_text")))
  );
}

function coerceCanvasPreview(
  preview: RawCanvasPreview,
):
  | Extract<NonNullable<NormalizedMessage["content"][number]>, { type: "canvas" }>["preview"]
  | null {
  if (!preview) {
    return null;
  }
  if (preview.kind !== "canvas" || preview.surface === "tool_card") {
    return null;
  }
  const render = preview.render === "url" ? "url" : null;
  if (!render) {
    return null;
  }
  const mcpApp = preview.mcpApp;
  const boardWidgetName = isCanvasBoardWidgetName(preview.boardWidgetName)
    ? preview.boardWidgetName
    : undefined;
  return {
    kind: "canvas",
    surface: "assistant_message",
    render,
    ...(preview.title !== undefined ? { title: preview.title } : {}),
    ...(preview.preferredHeight !== undefined ? { preferredHeight: preview.preferredHeight } : {}),
    ...(preview.url !== undefined ? { url: preview.url } : {}),
    ...(preview.viewId !== undefined ? { viewId: preview.viewId } : {}),
    ...(preview.className !== undefined ? { className: preview.className } : {}),
    ...(preview.style !== undefined ? { style: preview.style } : {}),
    ...(preview.sandbox === "strict" || preview.sandbox === "scripts"
      ? { sandbox: preview.sandbox }
      : {}),
    ...(boardWidgetName ? { boardWidgetName } : {}),
    ...(mcpApp?.viewId?.trim()
      ? {
          mcpApp: {
            viewId: mcpApp.viewId,
            ...(mcpApp.serverName !== undefined ? { serverName: mcpApp.serverName } : {}),
            ...(mcpApp.toolName !== undefined ? { toolName: mcpApp.toolName } : {}),
            ...(mcpApp.uiResourceUri !== undefined ? { uiResourceUri: mcpApp.uiResourceUri } : {}),
            ...(mcpApp.toolCallId !== undefined ? { toolCallId: mcpApp.toolCallId } : {}),
            ...(mcpApp.originSessionKey !== undefined
              ? { originSessionKey: mcpApp.originSessionKey }
              : {}),
          },
        }
      : {}),
  };
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
  item: RawContentBlock,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  if (item.type !== "audio") {
    return null;
  }
  const source = item.source;
  if (!source) {
    return null;
  }
  const mediaType = source.media_type?.trim().toLowerCase().startsWith("audio/")
    ? source.media_type.trim()
    : "audio/mpeg";
  if (source.type === "base64" && source.data !== undefined) {
    const data = source.data.trim();
    if (!data) {
      return null;
    }
    const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
    return {
      type: "attachment",
      attachment: {
        url,
        kind: "audio",
        label: item.label?.trim() || "Audio",
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  if (source.type === "url" && source.url !== undefined) {
    const url = source.url.trim();
    if (!url) {
      return null;
    }
    return {
      type: "attachment",
      attachment: {
        url,
        kind: "audio",
        label: item.label?.trim() || "Audio",
        mimeType: mediaType,
        ...(item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      },
    };
  }
  return null;
}

function coerceManagedMediaContentBlock(
  item: RawContentBlock,
): Extract<MessageContentItem, { type: "attachment" }> | null {
  if ((item.type !== "audio" && item.type !== "video") || item.url === undefined) {
    return null;
  }
  const url = item.url.trim();
  if (!url) {
    return null;
  }
  const kind = item.type;
  const fallbackLabel = kind === "audio" ? "Audio" : "Video";
  const label = item.fileName?.trim() || item.label?.trim() || fallbackLabel;
  return {
    type: "attachment",
    attachment: {
      url,
      kind,
      label,
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
      ...(item.artifactId !== undefined ? { artifactId: item.artifactId } : {}),
      ...(kind === "audio" && item.isVoiceNote === true ? { isVoiceNote: true } : {}),
      ...(item.playback === "native" || item.playback === "transcode"
        ? { playback: item.playback }
        : {}),
      ...(item.sizeBytes !== undefined && item.sizeBytes >= 0 ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.durationMs !== undefined && item.durationMs >= 0
        ? { durationMs: item.durationMs }
        : {}),
      ...(kind === "video" && item.width !== undefined && item.width > 0
        ? { width: item.width }
        : {}),
      ...(kind === "video" && item.height !== undefined && item.height > 0
        ? { height: item.height }
        : {}),
    },
  };
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
  delivery: z.infer<typeof rawOpenClawDeliverySchema>,
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
    if (preview.surface !== "assistant_message") {
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
  const m = rawMessageSchema.parse(message);
  let role = m.role ?? "unknown";

  // Detect tool messages by common gateway shapes.
  // Some tool events come through as assistant role with tool_* items in the content array.
  const hasToolId =
    m.toolCallId !== undefined ||
    m.tool_call_id !== undefined ||
    m.toolUseId !== undefined ||
    m.tool_use_id !== undefined;

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    contentItems?.some(
      (item) => isToolResultContentType(item.type) || isToolCallContentType(item.type),
    ) ?? false;

  const hasToolName = m.toolName !== undefined || m.tool_name !== undefined;

  if (hasToolId || hasToolContent || hasToolName) {
    role = "toolResult";
  }
  const isAssistantMessage = role === "assistant";
  const delivery = isAssistantMessage ? m.openclawDelivery : undefined;

  // Extract content
  let content: MessageContentItem[] = [];
  let audioAsVoice = false;
  let replyTarget: NormalizedMessage["replyTarget"] = null;

  if (typeof m.content === "string") {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.content, delivery);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.content }];
    }
  } else if (contentItems) {
    content = contentItems.flatMap((item) => {
      if (isAssistantMessage) {
        const managedMediaAttachment = coerceManagedMediaContentBlock(item);
        if (managedMediaAttachment) {
          return [managedMediaAttachment];
        }
        const audioAttachment = coerceAudioContentBlock(item);
        if (audioAttachment) {
          return [audioAttachment];
        }
      } else if (item.type === "audio") {
        return [];
      }
      const attachmentContent = normalizeAttachmentContentBlock(item);
      if (attachmentContent) {
        return attachmentContent;
      }
      if (item.type === "canvas" && item.preview) {
        const preview = coerceCanvasPreview(item.preview);
        if (!preview) {
          return [];
        }
        return [
          {
            type: "canvas" as const,
            preview,
            rawText: item.rawText ?? null,
          },
        ];
      }
      if (isTextContentBlock(item, role)) {
        if (isAssistantMessage) {
          const expanded = expandTextContent(item.text, delivery);
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
            text: item.text,
            name: undefined,
            args: undefined,
          },
        ];
      }
      return [
        {
          type:
            (item.type as Extract<
              MessageContentItem,
              { type: "text" | "tool_call" | "tool_result" }
            >["type"]) || "text",
          text: item.text as string | undefined,
          name: item.name as string | undefined,
          args: resolveToolBlockArgs(item),
        },
      ];
    });
  } else if (m.text !== undefined) {
    if (isAssistantMessage) {
      const expanded = expandTextContent(m.text, delivery);
      content = expanded.content;
      audioAsVoice = expanded.audioAsVoice;
      replyTarget = expanded.replyTarget;
    } else {
      content = [{ type: "text", text: m.text }];
    }
  }

  const timestamp = m.timestamp ?? Date.now();
  const id = m.id;
  const openClawMeta = m["__openclaw"];
  const structuredReplyToId = openClawMeta?.replyToId?.trim() ?? "";
  if (structuredReplyToId) {
    replyTarget = { kind: "id", id: structuredReplyToId };
  }
  const replyPreviewRecord = openClawMeta?.replyToPreview;
  const replyPreviewText = replyPreviewRecord?.text?.trim() ?? "";
  const replyPreviewSender = replyPreviewRecord?.senderLabel?.trim() ?? "";
  const identity = readTranscriptSenderIdentity(openClawMeta?.senderIdentity);
  const metaSender = normalizeSenderIdentity({
    identity,
    id: openClawMeta?.senderId,
    name: openClawMeta?.senderName,
    username: openClawMeta?.senderUsername,
    profileAvatarUrl:
      identity?.type === "profile" ? openClawMeta?.senderProfileAvatarUrl : undefined,
  });
  const rawLabel = m.senderLabel?.trim() ?? "";
  const senderLabel = rawLabel
    ? rawLabel.replace(OPAQUE_ID_LABEL_SUFFIX_RE, "").trim()
    : formatSenderLabel(metaSender);
  const sender = metaSender ?? (senderLabel ? { name: senderLabel } : null);

  content = stripMessageDisplayMetadata(content);

  return {
    role,
    content,
    timestamp,
    id,
    senderLabel,
    ...(m.senderSession ? { senderSession: m.senderSession } : {}),
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
