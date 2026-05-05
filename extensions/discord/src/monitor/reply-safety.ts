import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-runtime";

const DISCORD_INTERNAL_TRACE_LINE_RE =
  /^(?:>\s*)?(?:📊|🛠️|📖|📝|🔍|🔎|⚙️)\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/i;
const DISCORD_INTERNAL_CHANNEL_LINE_RE =
  /^(?:>\s*)?(?:analysis|commentary|tool[-_ ]?call|tool[-_ ]?result|function[-_ ]?call|thinking|reasoning)\s*[:=]/i;

function hasNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
  );
}

function hasInteractiveOrPresentationBlocks(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title === "string" && record.title.trim().length > 0) {
    return true;
  }
  return Array.isArray(record.blocks) && record.blocks.length > 0;
}

function hasNonTextReplyPayloadContent(payload: ReplyPayload): boolean {
  return (
    payload.audioAsVoice === true ||
    hasNonEmptyRecord(payload.channelData) ||
    hasInteractiveOrPresentationBlocks(payload.interactive) ||
    hasInteractiveOrPresentationBlocks(payload.presentation)
  );
}

function stripDiscordInternalTraceLines(text: string): string {
  let inFence = false;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (!inFence) {
      const trimmed = line.trim();
      if (
        DISCORD_INTERNAL_TRACE_LINE_RE.test(trimmed) ||
        DISCORD_INTERNAL_CHANNEL_LINE_RE.test(trimmed)
      ) {
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export function sanitizeDiscordFrontChannelText(text: string): string {
  const withoutAssistantScaffolding = sanitizeAssistantVisibleText(text);
  const withoutTraceLines = stripDiscordInternalTraceLines(withoutAssistantScaffolding);
  return collapseExcessBlankLines(withoutTraceLines).trim();
}

export function sanitizeDiscordFrontChannelReplyPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  const safePayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    const safeText =
      typeof payload.text === "string"
        ? sanitizeDiscordFrontChannelText(payload.text)
        : payload.text;
    const nextPayload =
      safeText === payload.text
        ? payload
        : ({ ...payload, text: safeText || undefined } as ReplyPayload);
    const nextParts = resolveSendableOutboundReplyParts(nextPayload);
    if (!nextParts.hasContent && !hasNonTextReplyPayloadContent(nextPayload)) {
      continue;
    }
    safePayloads.push(nextPayload);
  }
  return safePayloads;
}
