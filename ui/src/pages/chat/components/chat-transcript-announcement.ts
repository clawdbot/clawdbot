import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";

export type TranscriptAnnouncement = {
  key: string;
  text: string;
};

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];
const ANNOUNCEMENT_MAX_CHARS = 500;

function assistantGroupAnnouncementSource(
  group: MessageGroup,
): { key: string; text: string } | null {
  if (group.role.toLowerCase() !== "assistant") {
    return null;
  }
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const source = group.messages[index];
    const text = extractTextCached(source?.message)?.trim();
    if (text) {
      return { key: source?.key ?? group.key, text };
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
      if (item.outcome.kind === "completed") {
        const owner = item.outcome.actionOwner;
        const text = owner ? extractTextCached(owner.message)?.trim() : null;
        if (owner && text) {
          return announcement(owner.key, text);
        }
        continue;
      }
      if (item.outcome.kind === "failed") {
        continue;
      }
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
            return announcement(text.key, text.text.trim());
          }
          continue;
        }
        const groups = part.kind === "group" ? [part] : part.groups.toReversed();
        for (const group of groups) {
          const source = assistantGroupAnnouncementSource(group);
          if (source) {
            return announcement(source.key, source.text);
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
      const source = assistantGroupAnnouncementSource(group);
      if (source) {
        return announcement(source.key, source.text);
      }
    }
  }
  return null;
}

export class TranscriptAnnouncementState {
  private key: string | null | undefined;
  text = "";

  sync(announcement: TranscriptAnnouncement | null, announce: boolean): void {
    if (this.key === undefined || !announce) {
      this.key = announcement?.key ?? null;
      this.text = "";
    } else if (announcement && announcement.key !== this.key) {
      this.key = announcement.key;
      this.text = announcement.text;
    }
  }
}
