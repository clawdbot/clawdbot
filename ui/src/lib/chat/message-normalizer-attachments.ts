import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageContentItem } from "./chat-types.ts";

function isAttachmentKind(kind: unknown): kind is "image" | "audio" | "video" | "document" {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "document";
}

export function normalizeAttachmentContentBlock(value: unknown): MessageContentItem[] | undefined {
  const item = asOptionalRecord(value);
  if (!item || (item.type !== "attachment" && item.type !== "attachment_error")) {
    return undefined;
  }
  const attachment = asOptionalRecord(item.attachment);
  if (!attachment || !isAttachmentKind(attachment.kind) || typeof attachment.label !== "string") {
    return [];
  }
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : undefined;
  if (item.type === "attachment_error") {
    if (
      attachment.code !== "file-not-found" &&
      attachment.code !== "unsupported-format" &&
      attachment.code !== "delivery-failed"
    ) {
      return [];
    }
    return [
      {
        type: "attachment_error",
        attachment: {
          code: attachment.code,
          kind: attachment.kind,
          label: attachment.label,
          ...(mimeType !== undefined ? { mimeType } : {}),
        },
      },
    ];
  }
  if (typeof attachment.url !== "string") {
    return [];
  }
  return [
    {
      type: "attachment",
      attachment: {
        url: attachment.url,
        kind: attachment.kind,
        label: attachment.label,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(attachment.isVoiceNote === true ? { isVoiceNote: true } : {}),
        ...(typeof attachment.artifactId === "string" ? { artifactId: attachment.artifactId } : {}),
        ...(attachment.playback === "native" || attachment.playback === "transcode"
          ? { playback: attachment.playback }
          : {}),
        ...(typeof attachment.sizeBytes === "number" && attachment.sizeBytes >= 0
          ? { sizeBytes: attachment.sizeBytes }
          : {}),
        ...(typeof attachment.durationMs === "number" && attachment.durationMs >= 0
          ? { durationMs: attachment.durationMs }
          : {}),
        ...(typeof attachment.width === "number" && attachment.width > 0
          ? { width: attachment.width }
          : {}),
        ...(typeof attachment.height === "number" && attachment.height > 0
          ? { height: attachment.height }
          : {}),
      },
    },
  ];
}
