/**
 * Format a ref-index entry into text suitable for model context.
 *
 * Delegates all attachment rendering to the shared
 * `utils/attachment-tags.ts::renderAttachmentTags` (with `mode: "ref"`)
 * so the quoted-message preview and the current-message history use
 * identical wording for identical attachment types.
 */

import { renderAttachmentTags } from "../utils/attachment-tags.js";
import type { RefIndexEntry } from "./types.js";

/** Format a ref-index entry into text suitable for model context. */
export function formatRefEntryForAgent(entry: RefIndexEntry): string {
  const parts: string[] = [];

  if (entry.content.trim()) {
    parts.push(entry.content);
  }

  const attachmentTags = renderAttachmentTags(entry.attachments, { mode: "ref" });
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join(" ") || "[empty message]";
}
