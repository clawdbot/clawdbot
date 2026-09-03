// Extracts media attachment references from reply history entries.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { expectDefined } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MediaAttachment } from "../../media-understanding/types.js";
import type { MsgContext } from "../templating.js";
import type { HistoryEntry } from "./history.types.js";

const RECENT_HISTORY_IMAGE_TTL_MS = 30 * 60_000;
const RECENT_HISTORY_IMAGE_LIMIT = 4;

export type RecentInboundHistoryImage = {
  path: string;
  contentType?: string;
  kind?: MediaAttachment["kind"];
  sender: string;
  sentAtMs: number;
  messagePosition: number;
  messageCount: number;
  messageId?: string;
};

function isRemotePath(value: string): boolean {
  if (/^[a-z]:[\\/]/i.test(value)) {
    return false;
  }
  try {
    return new URL(value).protocol !== "file:";
  } catch {
    return false;
  }
}

function resolveTimestamp(value: unknown): number | undefined {
  return asFiniteNumber(value);
}

function resolveHistoryEntries(ctx: MsgContext): HistoryEntry[] {
  return Array.isArray(ctx.InboundHistory) ? ctx.InboundHistory : [];
}

export function resolveRecentInboundHistoryImages(params: {
  ctx: MsgContext;
  // Inject the canonical classifier so text-only ACP turns never eagerly load media runtime.
  isImageAttachment: (attachment: MediaAttachment) => boolean;
  nowMs?: number;
  ttlMs?: number;
  limit?: number;
}): RecentInboundHistoryImage[] {
  const nowMs = params.nowMs ?? resolveTimestamp(params.ctx.Timestamp) ?? Date.now();
  const ttlMs = params.ttlMs ?? RECENT_HISTORY_IMAGE_TTL_MS;
  const limit = Math.max(0, params.limit ?? RECENT_HISTORY_IMAGE_LIMIT);
  if (limit === 0) {
    return [];
  }

  const out: RecentInboundHistoryImage[] = [];
  const seen = new Set<string>();
  const entries = resolveHistoryEntries(params.ctx);
  for (let index = entries.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const entry = expectDefined(entries[index], "entries entry at index");
    const timestamp = resolveTimestamp(entry?.timestamp);
    if (timestamp === undefined || Math.abs(nowMs - timestamp) > ttlMs) {
      continue;
    }
    const mediaEntries = Array.isArray(entry.media) ? entry.media : [];
    for (
      let mediaIndex = mediaEntries.length - 1;
      mediaIndex >= 0 && out.length < limit;
      mediaIndex -= 1
    ) {
      const media = mediaEntries[mediaIndex];
      if (
        !media ||
        !params.isImageAttachment({
          path: media.path,
          url: media.url,
          mime: media.contentType,
          kind: media.kind,
          index: mediaIndex,
        })
      ) {
        continue;
      }
      const mediaPath = normalizeOptionalString(media.path);
      if (!mediaPath || isRemotePath(mediaPath)) {
        continue;
      }
      const contentType =
        normalizeOptionalString(media.contentType) ?? mimeTypeFromFilePath(mediaPath);
      const messageId = normalizeOptionalString(media.messageId) ?? entry.messageId;
      const key = [messageId ?? "", mediaPath].join("\0");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        path: mediaPath,
        ...(contentType ? { contentType } : {}),
        ...(media.kind ? { kind: media.kind } : {}),
        sender: entry.sender,
        sentAtMs: timestamp,
        messagePosition: index + 1,
        messageCount: entries.length,
        ...(messageId ? { messageId } : {}),
      });
    }
  }
  return out.toReversed();
}

function formatRecentHistoryImageSentAt(sentAtMs: number): string {
  const date = new Date(sentAtMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${sentAtMs}ms since epoch`;
}

export function appendRecentHistoryImageContext(params: {
  promptText: string;
  images: RecentInboundHistoryImage[];
}): string {
  if (params.images.length === 0) {
    return params.promptText;
  }
  const notes = params.images.map((image, index) => {
    const message = image.messageId ? `, message ${image.messageId}` : "";
    const sentAt = formatRecentHistoryImageSentAt(image.sentAtMs);
    return `[Recent image ${index + 1} from ${image.sender}${message}, sent at ${sentAt}, message ${image.messagePosition} of ${image.messageCount} in available history, attached as media.]`;
  });
  return [params.promptText, notes.join("\n")]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}
