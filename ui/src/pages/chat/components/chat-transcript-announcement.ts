import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import type { TranscriptAnnouncement } from "./chat-transcript-controller.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];
const ANNOUNCEMENT_MAX_CHARS = 500;

function assistantGroupText(group: MessageGroup): string | null {
  if (group.role.toLowerCase() !== "assistant") {
    return null;
  }
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const text = extractTextCached(group.messages[index]?.message)?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

export function latestTranscriptAnnouncement(
  items: readonly ChatRenderItem[],
): TranscriptAnnouncement | null {
  const announcement = (key: string, text: string): TranscriptAnnouncement => ({
    key,
    text: truncateUtf16Safe(text, ANNOUNCEMENT_MAX_CHARS),
  });
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (!item) {
      continue;
    }
    if (item.kind === "agent-run-frame") {
      for (let partIndex = item.parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = item.parts[partIndex];
        if (!part) {
          continue;
        }
        if (part.kind === "stream-run") {
          const text = part.parts.findLast(
            (streamPart) => streamPart.kind === "stream" && streamPart.text.trim(),
          );
          if (text?.kind === "stream") {
            return announcement(item.key, text.text.trim());
          }
          continue;
        }
        const groups = part.kind === "group" ? [part] : part.groups;
        for (let index = groups.length - 1; index >= 0; index -= 1) {
          const group = groups[index];
          const text = group ? assistantGroupText(group) : null;
          if (text) {
            return announcement(item.key, text);
          }
        }
      }
      continue;
    }
    const groups =
      item.kind === "group"
        ? [item]
        : item.kind === "work-group" || item.kind === "activity-run"
          ? item.groups.toReversed()
          : [];
    for (const group of groups) {
      const text = assistantGroupText(group);
      if (text) {
        return announcement(item.key, text);
      }
    }
  }
  return null;
}
