import { mimeTypeFromFilePath } from "../../media/mime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { HistoryEntry, HistoryMediaEntry } from "./history.types.js";

export const RECENT_HISTORY_IMAGE_TTL_MS = 30 * 60_000;
export const RECENT_HISTORY_IMAGE_LIMIT = 4;

export type RecentInboundHistoryImage = {
  path: string;
  contentType: string;
  sender: string;
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

function resolveHistoryImageContentType(media: HistoryMediaEntry): string | undefined {
  const contentType = normalizeOptionalString(media.contentType);
  if (contentType?.startsWith("image/")) {
    return contentType;
  }
  const path = normalizeOptionalString(media.path);
  return mimeTypeFromFilePath(path);
}

function isHistoryImageMedia(media: HistoryMediaEntry): boolean {
  if (media.kind === "image") {
    return true;
  }
  return Boolean(resolveHistoryImageContentType(media)?.startsWith("image/"));
}

function resolveTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveHistoryEntries(ctx: FinalizedMsgContext): HistoryEntry[] {
  return Array.isArray(ctx.InboundHistory) ? ctx.InboundHistory : [];
}

export function resolveRecentInboundHistoryImages(params: {
  ctx: FinalizedMsgContext;
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
    const entry = entries[index];
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
      if (!media || !isHistoryImageMedia(media)) {
        continue;
      }
      const mediaPath = normalizeOptionalString(media.path);
      if (!mediaPath || isRemotePath(mediaPath)) {
        continue;
      }
      const contentType = resolveHistoryImageContentType(media);
      if (!contentType?.startsWith("image/")) {
        continue;
      }
      const messageId = normalizeOptionalString(media.messageId) ?? entry.messageId;
      const key = [messageId ?? "", mediaPath].join("\0");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        path: mediaPath,
        contentType,
        sender: entry.sender,
        ...(messageId ? { messageId } : {}),
      });
    }
  }
  return out.toReversed();
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
    return `[Recent image ${index + 1} from ${image.sender}${message}, attached as media.]`;
  });
  return [params.promptText, notes.join("\n")]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}
