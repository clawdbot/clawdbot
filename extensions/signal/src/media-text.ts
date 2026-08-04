import {
  formatMediaPlaceholderText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";

function formatAttachmentKindCount(kind: string, count: number): string {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}

/** Keeps Signal's established multi-attachment text while sharing single-item rendering. */
export function formatSignalMediaText(media: readonly MediaPlaceholderTextFact[]): string {
  if (media.length <= 1) {
    return formatMediaPlaceholderText(media);
  }
  const kindCounts = new Map<string, number>();
  for (const entry of media) {
    const kind =
      entry.kind && entry.kind !== "unknown"
        ? entry.kind
        : (kindFromMime(entry.contentType) ?? "attachment");
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(([kind, count]) =>
    formatAttachmentKindCount(kind, count),
  );
  return `[${parts.join(" + ")} attached]`;
}
