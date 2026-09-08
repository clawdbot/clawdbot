import { findCodeRegions, isInsideCode, type CodeRegion } from "./code-regions.js";

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

/** Removes standalone message-id hint lines without touching inline user mentions. */
export function stripMessageIdHints(text: string): string {
  if (!/\[message_id:/i.test(text)) {
    return text;
  }
  // Match parser offsets against the same LF-normalized lines used for removal.
  // Return the original bytes when no generated hint is removed.
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let offset = 0;
  let regions: CodeRegion[] | undefined;
  const filtered = lines.filter((line) => {
    const markerOffset = line.search(/\[message_id:/i);
    const shouldRemove =
      markerOffset >= 0 &&
      MESSAGE_ID_LINE.test(line) &&
      !isInsideCode(offset + markerOffset, (regions ??= findCodeRegions(normalized)));
    offset += line.length + 1;
    return !shouldRemove;
  });
  return filtered.length === lines.length ? text : filtered.join("\n");
}
