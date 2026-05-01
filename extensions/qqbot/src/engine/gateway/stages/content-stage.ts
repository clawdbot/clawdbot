/**
 * Content stage — build the user-visible message body.
 *
 * Responsible for:
 *   1. Parsing QQ emoji tags (`<faceType=...>` → `[Emoji: name]`)
 *   2. Appending attachment info + voice transcripts
 *   3. Stripping `<@openid>` mention tags in group messages
 *   4. Replacing `<@openid>` → `@nickname` in DMs (best-effort)
 *
 * Pure function: same input → same output, no I/O.
 */

import { stripMentionText } from "../../group/mention.js";
import { parseFaceTags } from "../../utils/text-parsing.js";
import { formatVoiceText } from "../../utils/voice-text.js";
import type { QueuedMention, QueuedMessage } from "../message-queue.js";

// ─────────────────────────── Types ───────────────────────────

/** Input for {@link buildUserContent}. */
interface ContentStageInput {
  event: QueuedMessage;
  /** `attachmentInfo` from the attachment stage — appended verbatim. */
  attachmentInfo: string;
  /** Voice transcripts collected from the attachment stage. */
  voiceTranscripts: string[];
}

/** Output of {@link buildUserContent}. */
interface ContentStageOutput {
  /** `parseFaceTags(event.content)`. */
  parsedContent: string;
  /** Full user-visible content (parsed + voice + attachments + mention cleanup). */
  userContent: string;
}

// ─────────────────────────── Stage ───────────────────────────

/**
 * Build both the raw-parsed content and the fully composed user-visible
 * body that downstream stages feed to the AI and to the envelope.
 */
export function buildUserContent(input: ContentStageInput): ContentStageOutput {
  const { event, attachmentInfo, voiceTranscripts } = input;

  const parsedContent = parseFaceTags(event.content);
  const voiceText = formatVoiceText(voiceTranscripts);

  let userContent = voiceText
    ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
    : parsedContent + attachmentInfo;

  // Mention cleanup — only for events with mentions attached.
  if (event.type === "group" && event.mentions?.length) {
    userContent = stripMentionText(userContent, event.mentions as never) ?? userContent;
  } else if (event.mentions?.length) {
    userContent = replaceMentionsWithNicknames(userContent, event.mentions);
  }

  return { parsedContent, userContent };
}

// ─────────────────────────── Internal ───────────────────────────

function replaceMentionsWithNicknames(text: string, mentions: QueuedMention[]): string {
  let out = text;
  for (const m of mentions) {
    if (m.member_openid && m.username) {
      out = out.replace(new RegExp(`<@${escapeRegex(m.member_openid)}>`, "g"), `@${m.username}`);
    }
  }
  return out;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
