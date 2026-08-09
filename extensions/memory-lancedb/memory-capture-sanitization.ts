import { BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES } from "openclaw/plugin-sdk/chat-channel-ids";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MEDIA_NOTE_HEADER = /^\[media attached(?: \d+\/\d+)?: /;

function stripMediaNoteLine(line: string): string | null {
  // Prompt assembly puts captions on following lines; inline legacy text stays ordinary content.
  return MEDIA_NOTE_HEADER.test(line) && line.endsWith("]") ? null : line;
}

export function dropMediaNoteLines(text: string): string {
  return text
    .split("\n")
    .map(stripMediaNoteLine)
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Provenance marker appended to every OpenClaw-injected inbound context header
 * by `buildInboundUserContextPrefix`. `sanitizeForMemoryCapture` and
 * `looksLikeEnvelopeSludge` key on this marker rather than on label text, so
 * detection is label-agnostic (arbitrary plugin `ChannelStructuredContext`
 * labels are covered) and never collides with a user's own `<heading>:` + JSON.
 * The marker glyph is duplicated inline in the regexes below because extensions
 * must not import core internals; keep byte-identical with
 * `src/auto-reply/reply/inbound-context-marker.ts`.
 */
// A context header line: any line whose trimmed text ends with the marker.
const MARKER_HEADER_LINE_RE = /^[^\n]*⟦openclaw:ctx⟧[ \t]*$/m;
// A marker header immediately followed by its ```json fenced payload.
const MARKER_JSON_BLOCK_RE =
  /^[^\n]*⟦openclaw:ctx⟧[ \t]*\n[ \t]*```json[ \t]*\n[\s\S]*?\n[ \t]*```[ \t]*\n?/gm;
// A leading chronological-window marker header (`... (chronological, ...): ⟦marker⟧`).
// Scoped to the chronological window blocks only: those carry the "keep the real
// inbound envelope inside the window" handling in stripLeadingChronologicalContextBlocks.
// Other prose headers (chat history, thread starter) defer to the current-message
// marker via the sanitize pass-loop, so they must NOT match here.
const LEADING_CHRONOLOGICAL_MARKER_HEADER_RE =
  /^\s*[^\n]*chronological[^\n]*⟦openclaw:ctx⟧[ \t]*(?:\n|$)/;

const MESSAGE_TOOL_DELIVERY_HINT_RE = new RegExp(
  `^\\s*(?:${MESSAGE_TOOL_DELIVERY_HINTS.map((hint) =>
    hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})\\s*$`,
  "m",
);
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
const HISTORY_CONTEXT_MARKERS = [
  HISTORY_CONTEXT_MARKER,
  "[Chat messages since your last reply \u2014 CONTEXT ONLY]",
  "[Merged earlier messages \u2014 CONTEXT ONLY]",
] as const;
const CURRENT_MESSAGE_MARKERS = [
  CURRENT_MESSAGE_MARKER,
  "[CURRENT MESSAGE \u2014 reply to this]",
  "[CURRENT MESSAGE \u2014 reply using the context above]",
] as const;

const ACTIVE_TURN_RECOVERY_RE = /active-turn-recovery/i;

const BRACKETED_PREFIX_RE = /\[[^\]\n]{1,500}\]\s/g;
const LEADING_CURRENT_MESSAGE_CONTEXT_RE = /^\s*Current message:[ \t]*(?:\n|$)/;
const LEADING_CURRENT_MESSAGE_REPLY_LINE_RE = /^\s*\[Replying to:[^\n]{0,1000}\]\s*\n/;
const LEADING_CURRENT_MESSAGE_ID_SENDER_RE = /^#\d+\s+[^\n:]{1,100}:\s*/;

const CONTEXT_HEADER_RE = /^Context:[ \t]*⟦openclaw:ctx⟧[ \t]*$/m;

/**
 * Matches JSON blobs that look like OpenClaw transport envelope metadata.
 * Orthogonal to the header marker: it catches a bare envelope payload by its
 * compound keys even when no marker header precedes it (e.g. a fragment that
 * leaked outside its ```json fence). Core's `formatContextJsonBlock` emits
 * compact single-line JSON; the optional-newline branch also catches legacy
 * pretty-printed blocks. Key list mirrors envelope identifiers used by
 * `buildInboundUserContextPrefix` and stays narrow to avoid false-positives on
 * legitimate user JSON with bare keys like "conversation" or "sender".
 */
const ENVELOPE_JSON_LINE_RE =
  /^\s*\{\s*(?:\n\s*)?"(?:chat_id|message_id|reply_to_id|sender_id|conversation_label|conversation_info|sender_name|channel_id|channel_type|group_subject|group_channel|group_space|topic_id|thread_label)"\s*:/m;

/**
 * Leading bracketed envelope header injected by `formatAgentEnvelope` /
 * `formatInboundEnvelope` (src/auto-reply/envelope.ts). Real shape, with parts
 * joined by spaces inside a single `[...]`:
 *
 *   `[<channel> <from> +<elapsed>? <host>? <ip>? <Wkd YYYY-MM-DD HH:MM TZ>?] <body>`
 *
 * Examples:
 *   `[Telegram Alice +5m] I prefer dark mode`
 *   `[Telegram Group id:123 Alice +5m Mon 2026-05-17 14:30 EDT] Alice: text`
 *   `[Discord #general user +0s Mon 2026-05-17T14:30Z] text`
 *
 * Detection keys on the load-bearing parts that mark this header as an
 * envelope (rather than arbitrary user-typed `[brackets]`): an elapsed marker
 * `+<n><unit>` produced by `formatTimeAgo({suffix:false})` (units: s/m/h/d, or
 * the literal `just now` fallback), or a weekday + ISO date pair produced by
 * `formatEnvelopeTimestamp`. Either marker is unique enough that quoting
 * `[5m]` or `[Mon 2026-05-17]` mid-sentence will not look like an envelope
 * prefix because the regex is anchored to start-of-string and requires the
 * marker to live inside the leading bracket followed by `]<space>`.
 *
 * Capture group 1 is the inside-bracket text, used by the sender-prefix
 * gating logic in `sanitizeForMemoryCapture` to scope which body labels we
 * are willing to strip. Header part length is capped at 300 chars to avoid
 * catastrophic backtracking on pathological inputs; real envelopes are well
 * under that.
 */
const INBOUND_ENVELOPE_PREFIX_RE =
  /^\[([^\]\n]{0,300}?(?:\s\+(?:\d+[smhdwy]|just now)\b|\s[A-Za-z]{3}\s\d{4}-\d{2}-\d{2})[^\]\n]{0,200})\]\s/;

/**
 * Marker-free leading envelope header. The elapsed/date marker regex above
 * misses envelopes where `formatAgentEnvelope` drops every optional marker.
 * Because channel labels can also be ordinary words, callers only accept this
 * match after `matchKnownChannelMarkerFreeEnvelopePrefix` finds a stronger
 * group/thread or body-sender signal.
 *
 * Anchoring on a known bundled/official channel prefix from
 * `BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES` keeps the detector and formatter in
 * sync across callers that pass either ids or display labels like `Google Chat`.
 * Case insensitive because the formatter does not lowercase `params.channel`
 * itself; production paths feed mixed ids and labels.
 *
 * From-label must be at least one non-whitespace token so user prose like
 * `[note]` or `[telegram] ...` (no following label) is not mistaken for an
 * envelope. Capture group 1 is the inside-bracket text (channel + from-label
 * and any remaining header parts), used by the sender-prefix gating logic in
 * `sanitizeForMemoryCapture`. Header part length is capped at 300 chars to
 * match the marker-aware regex above and avoid catastrophic backtracking.
 *
 * Guarded against an empty `BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES` so the
 * alternation never degenerates into `(?:)` (which would match the empty string
 * and flag every `[...]` prefix as an envelope). When the bundled list is empty the
 * known-channel detector is disabled and only the marker-aware regex above
 * applies.
 */
const ENVELOPE_KNOWN_CHANNEL_PATTERN = BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES.map((prefix) =>
  prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");
const INBOUND_ENVELOPE_KNOWN_CHANNEL_PREFIX_RE: RegExp | null = ENVELOPE_KNOWN_CHANNEL_PATTERN
  ? new RegExp(
      `^\\[((?:${ENVELOPE_KNOWN_CHANNEL_PATTERN})\\s+[^\\]\\n\\s][^\\]\\n]{0,299})\\]\\s`,
      "i",
    )
  : null;

/**
 * Group-chat envelope bodies prepend `<Sender>: ` to the raw user text (see
 * `formatInboundEnvelope`). After stripping the leading envelope bracket,
 * this pattern matches that body sender prefix; capture group 1 is the label
 * itself so the gated strip in `sanitizeForMemoryCapture` can compare it
 * against the envelope header before removing it. Sender label is capped at
 * the same length as `sanitizeEnvelopeHeaderPart` would produce in practice
 * (the envelope formatter does not truncate, but a 120-char ceiling keeps the
 * regex bounded and matches realistic display names).
 */
const ENVELOPE_BODY_SENDER_PREFIX_RE = /^([^\n:]{1,120}):\s/;
const ENVELOPE_BODY_DIRECT_PREFIX = "(sender)";
const ENVELOPE_BODY_SELF_PREFIX = "(self)";
const SENDER_PREFIXED_ENVELOPE_CHANNEL_RE =
  /^(?:discord|imessage|line|mattermost|qqbot|signal|slack|telegram|whatsapp)(?:\s|$)/i;
const NON_DIRECT_ENVELOPE_HEADER_RE =
  /(?:^|\s)(?:#[^\s]+|group:[^\s]+|group\s+id:[^\s]+|room:[^\s]+|channel\s+id:[^\s]+|id:-[^\s]+|unknown-group|[^\s]+@g\.us)(?:\s|$)/i;
const USER_AUTHORED_BODY_LABEL_RE = /^(?:action|decision|fixme|note|question|reminder|todo)$/i;

function matchKnownChannelMarkerFreeEnvelopePrefix(
  text: string,
  options?: { allowAmbiguousDirect?: boolean },
): RegExpMatchArray | null {
  const match = INBOUND_ENVELOPE_KNOWN_CHANNEL_PREFIX_RE?.exec(text);
  if (!match) {
    return null;
  }
  const headerInside = match[1] ?? "";
  if (NON_DIRECT_ENVELOPE_HEADER_RE.test(headerInside)) {
    return match;
  }
  const body = text.slice(match[0].length);
  if (stripEnvelopeBodySenderPrefix(body, headerInside) !== body) {
    return match;
  }
  return options?.allowAmbiguousDirect ? match : null;
}

/**
 * Returns true if `text` looks like it contains OpenClaw-injected envelope or
 * transport metadata that should never be persisted as a long-term memory.
 */
export function looksLikeEnvelopeSludge(text: string): boolean {
  if (!text) {
    return false;
  }

  // Generic line-anchored sentinel match; precompiled at module scope so the
  // hot-path callers (capture gating, recall filtering) do not pay a regex
  // compile per invocation.
  if (MARKER_HEADER_LINE_RE.test(text)) {
    return true;
  }

  if (MESSAGE_TOOL_DELIVERY_HINT_RE.test(text)) {
    return true;
  }

  if (
    HISTORY_CONTEXT_MARKERS.some((marker) => text.includes(marker)) ||
    CURRENT_MESSAGE_MARKERS.some((marker) => text.includes(marker))
  ) {
    return true;
  }

  if (ACTIVE_TURN_RECOVERY_RE.test(text)) {
    return true;
  }

  // Check for JSON blobs that look like envelope metadata (payload-based, header-independent).
  if (ENVELOPE_JSON_LINE_RE.test(text)) {
    return true;
  }

  // Check for the leading `[Channel sender +elapsed ...]` bracket emitted by
  // formatInboundEnvelope. Marker-free channel brackets need a stronger
  // group/thread or body-sender signal so user prose like `[Signal Hill] ...`
  // is not treated as transport metadata.
  return (
    INBOUND_ENVELOPE_PREFIX_RE.test(text) ||
    matchKnownChannelMarkerFreeEnvelopePrefix(text) !== null
  );
}

/**
 * Timestamp prefix pattern injected by `injectTimestamp`.
 * Canonical source: src/auto-reply/reply/strip-inbound-meta.ts
 */
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

/**
 * Decide whether a `<X>: ` body prefix that follows a stripped envelope
 * bracket was emitted by the formatter (vs being user-typed prose). The
 * formatter contract in `src/auto-reply/envelope.ts` only ever prepends:
 *   - `(self): ` for direct chats with `fromMe`, OR
 *   - `<resolvedSender>: ` for non-direct chats with a sender label.
 *
 * Some channel paths call `formatInboundEnvelope` and therefore put the room in
 * the header while keeping the sender as the body label, for example
 * `[Slack #general] Alice: text`. Generic `formatAgentEnvelope` callers and
 * direct `formatInboundEnvelope` bodies do not add that body label, so require
 * structural non-direct markers and preserve common user-authored labels like
 * `TODO:`.
 */
function stripEnvelopeBodySenderPrefix(body: string, headerInside: string): string {
  const match = body.match(ENVELOPE_BODY_SENDER_PREFIX_RE);
  if (!match) {
    return body;
  }
  const label = expectDefined(match[1], "envelope body sender capture");
  if (label === ENVELOPE_BODY_SELF_PREFIX || label === ENVELOPE_BODY_DIRECT_PREFIX) {
    return body.slice(match[0].length);
  }
  if (
    SENDER_PREFIXED_ENVELOPE_CHANNEL_RE.test(headerInside) &&
    NON_DIRECT_ENVELOPE_HEADER_RE.test(headerInside) &&
    !USER_AUTHORED_BODY_LABEL_RE.test(label)
  ) {
    return body.slice(match[0].length);
  }
  const headerTokens = headerInside.split(/\s+/);
  if (headerTokens.includes(label) || headerInside.includes(label)) {
    return body.slice(match[0].length);
  }
  return body;
}

function stripLeadingMessageToolDeliveryHints(text: string): string {
  const lines = text.split("\n");
  let index = 0;
  let stripped = false;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (!MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint === trimmed)) {
      break;
    }
    stripped = true;
    index += 1;
  }
  return stripped ? lines.slice(index).join("\n") : text;
}

function findFirstInboundEnvelopeIndex(
  text: string,
  options?: { allowAmbiguousMarkerFree?: boolean; skipReplyQuoteLine?: boolean },
) {
  for (const match of text.matchAll(BRACKETED_PREFIX_RE)) {
    const index = match.index;
    if (options?.skipReplyQuoteLine) {
      const lineStart = text.lastIndexOf("\n", index - 1) + 1;
      if (text.slice(lineStart, index).includes("[Replying to:")) {
        continue;
      }
    }
    const candidate = text.slice(index);
    if (
      INBOUND_ENVELOPE_PREFIX_RE.test(candidate) ||
      matchKnownChannelMarkerFreeEnvelopePrefix(candidate, {
        allowAmbiguousDirect: options?.allowAmbiguousMarkerFree,
      })
    ) {
      return index;
    }
  }
  return -1;
}

function stripPendingHistoryContextBeforeCurrentMessage(text: string): string {
  const candidateText = text.trimStart();
  if (!HISTORY_CONTEXT_MARKERS.some((marker) => candidateText.startsWith(marker))) {
    return text;
  }
  const currentMarker = findLastContextMarker(candidateText, CURRENT_MESSAGE_MARKERS);
  if (!currentMarker) {
    return text;
  }
  return candidateText.slice(currentMarker.index + currentMarker.marker.length);
}

function stripToCurrentMessageMarker(text: string): string | null {
  const currentMarker = findLastContextMarker(text, CURRENT_MESSAGE_MARKERS);
  if (!currentMarker) {
    return null;
  }
  return text.slice(currentMarker.index + currentMarker.marker.length);
}

function findLastContextMarker(
  text: string,
  markers: readonly string[],
): { index: number; marker: string } | null {
  let result: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index !== -1 && (!result || index > result.index)) {
      result = { index, marker };
    }
  }
  return result;
}

function stripLeadingCurrentMessageContextBeforeEnvelope(text: string): string {
  const candidateText = text.trimStart();
  if (!LEADING_CURRENT_MESSAGE_CONTEXT_RE.test(candidateText)) {
    return text;
  }
  const envelopeIndex = findFirstInboundEnvelopeIndex(candidateText, {
    allowAmbiguousMarkerFree: true,
    skipReplyQuoteLine: true,
  });
  if (envelopeIndex === -1) {
    let plainBody = candidateText.replace(LEADING_CURRENT_MESSAGE_CONTEXT_RE, "").trimStart();
    for (let pass = 0; pass < 4; pass += 1) {
      const replyLineMatch = plainBody.match(LEADING_CURRENT_MESSAGE_REPLY_LINE_RE);
      if (!replyLineMatch) {
        break;
      }
      plainBody = plainBody.slice(replyLineMatch[0].length).trimStart();
    }
    const currentMessagePrefixMatch = plainBody.match(LEADING_CURRENT_MESSAGE_ID_SENDER_RE);
    return currentMessagePrefixMatch ? plainBody.slice(currentMessagePrefixMatch[0].length) : text;
  }
  // `Current message:` is current-turn transport context. Strip it only when a
  // real current-message body follows; otherwise preserve the text for normal capture.
  return candidateText.slice(envelopeIndex);
}

function stripLeadingPlainTextMetadataBody(text: string): string {
  const candidateText = text.trimStart();
  const markerBody = stripToCurrentMessageMarker(candidateText);
  if (markerBody !== null) {
    return markerBody;
  }
  const currentMessageBody = stripLeadingCurrentMessageContextBeforeEnvelope(candidateText);
  return currentMessageBody === candidateText ? "" : currentMessageBody;
}

function stripLeadingInboundEnvelope(
  text: string,
  options?: { allowAmbiguousMarkerFree?: boolean },
): string {
  const strippedCandidate = stripLeadingCurrentMessageContextBeforeEnvelope(
    stripPendingHistoryContextBeforeCurrentMessage(stripLeadingMessageToolDeliveryHints(text)),
  );
  const candidateText = strippedCandidate.trimStart();
  const allowAmbiguousMarkerFree = options?.allowAmbiguousMarkerFree || strippedCandidate !== text;
  const envelopePrefixMatch =
    candidateText.match(INBOUND_ENVELOPE_PREFIX_RE) ??
    matchKnownChannelMarkerFreeEnvelopePrefix(candidateText, {
      allowAmbiguousDirect: allowAmbiguousMarkerFree,
    });
  if (!envelopePrefixMatch) {
    return strippedCandidate === text ? text : candidateText;
  }
  const headerInside = envelopePrefixMatch[1] ?? "";
  const afterBracket = candidateText.slice(envelopePrefixMatch[0].length);
  return stripEnvelopeBodySenderPrefix(afterBracket, headerInside);
}

function stripLeadingChronologicalContextBlocks(text: string): string {
  let cleaned = text;
  let remainingPasses = 16;
  while (remainingPasses > 0) {
    remainingPasses -= 1;
    const match = cleaned.match(LEADING_CHRONOLOGICAL_MARKER_HEADER_RE);
    if (!match) {
      return cleaned;
    }
    const afterLabel = cleaned.slice(match[0].length);
    const bodyStart = afterLabel.search(/\S/);
    if (bodyStart === -1) {
      return "";
    }
    const bodyLineEnd = afterLabel.indexOf("\n", bodyStart);
    const firstBodyLine =
      bodyLineEnd === -1 ? afterLabel.slice(bodyStart) : afterLabel.slice(bodyStart, bodyLineEnd);
    let lineEnvelopeIndex = firstBodyLine.trimStart().startsWith("[")
      ? findFirstInboundEnvelopeIndex(firstBodyLine, {
          allowAmbiguousMarkerFree: true,
          skipReplyQuoteLine: true,
        })
      : -1;
    if (lineEnvelopeIndex === -1 && match[0].includes("selected for current message")) {
      const inlineEnvelopeIndex = findFirstInboundEnvelopeIndex(firstBodyLine, {
        allowAmbiguousMarkerFree: true,
        skipReplyQuoteLine: true,
      });
      const prefix = inlineEnvelopeIndex === -1 ? "" : firstBodyLine.slice(0, inlineEnvelopeIndex);
      lineEnvelopeIndex = /^#\d+\s/.test(prefix.trimStart()) ? inlineEnvelopeIndex : -1;
    }
    const envelopeIndex = lineEnvelopeIndex === -1 ? -1 : bodyStart + lineEnvelopeIndex;
    if (envelopeIndex === -1) {
      const separatorMatch = /\n[ \t]*\n/.exec(afterLabel);
      cleaned = separatorMatch
        ? afterLabel.slice(separatorMatch.index + separatorMatch[0].length)
        : "";
    } else {
      cleaned = afterLabel.slice(envelopeIndex);
    }
    if (!cleaned) {
      return "";
    }
  }
  return cleaned;
}

/**
 * Strips OpenClaw-injected envelope metadata from a user message so that only
 * the user's actual intent text remains. Returns empty string if nothing
 * meaningful survives.
 */
export function sanitizeForMemoryCapture(text: string): string {
  if (!text) {
    return "";
  }

  // Pre-truncate to cap regex work on very large inputs (ReDoS mitigation)
  const MAX_SANITIZE_CHARS = 10_000;
  let cleaned =
    text.length > MAX_SANITIZE_CHARS ? truncateUtf16Safe(text, MAX_SANITIZE_CHARS) : text;
  let strippedInjectedContext = false;

  cleaned = cleaned.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  // Media notes are presentation-only prompt lines. Drop the whole rendered line;
  // never parse attachment identity back out of its text projection.
  cleaned = dropMediaNoteLines(cleaned);
  const afterDeliveryHints = stripLeadingMessageToolDeliveryHints(cleaned);
  strippedInjectedContext ||= afterDeliveryHints !== cleaned;
  cleaned = afterDeliveryHints;

  // Strip inbound metadata blocks: generic label line + optional ```json +
  // content + ```. This deliberately mirrors `looksLikeEnvelopeSludge`'s
  // generic label coverage so current reply-chain, location, and plugin-owned
  // structured-context labels do not make `shouldCapture` reject the useful
  // user body that follows.
  const afterJsonMetaBlocks = cleaned.replace(MARKER_JSON_BLOCK_RE, "");
  strippedInjectedContext ||= afterJsonMetaBlocks !== cleaned;
  cleaned = afterJsonMetaBlocks;

  // First strip legacy/inline sentinel+code-fence blocks; each replace removes
  // the entire block including its sentinel header so iteration order does not
  // matter.
  // Plain chat-window context blocks are untrusted history lines rather than
  // JSON metadata. When they lead the prompt, keep only the following real
  // inbound envelope; if no envelope follows, drop the context block entirely.
  const afterChronologicalContext = stripLeadingChronologicalContextBlocks(cleaned);
  strippedInjectedContext ||= afterChronologicalContext !== cleaned;
  cleaned = afterChronologicalContext;
  // For context headers that survived the code-fence strip (plain-text body,
  // no JSON fence — chat history/window), act on the earliest marker header
  // each pass. A bounded retry cap rules out pathological input from spinning
  // forever.
  for (let pass = 0; pass < 16; pass += 1) {
    const headerMatch = cleaned.match(MARKER_HEADER_LINE_RE);
    if (headerMatch?.index === undefined) {
      break;
    }
    const before = cleaned.slice(0, headerMatch.index);
    if (before.trim().length > 0) {
      // User content precedes the earliest context header -- truncate here so
      // every trailing context block (chat history, thread starter, etc.) is
      // dropped. No further passes are needed once the trailing text is gone.
      cleaned = before;
      break;
    }
    // Header sits at the very beginning. Fenced blocks were already removed
    // above, so this is a prose-body context header; drop the header line and
    // its plain-text body. A stray fenced block the block regex missed keeps
    // only its header removed so the next pass can retry.
    const lineEnd = cleaned.indexOf("\n");
    const afterHeader = lineEnd === -1 ? "" : cleaned.slice(lineEnd + 1);
    const afterPlainTextMetadata = afterHeader.trimStart().startsWith("```json")
      ? afterHeader
      : stripLeadingPlainTextMetadataBody(afterHeader);
    strippedInjectedContext ||= afterPlainTextMetadata !== cleaned;
    cleaned = afterPlainTextMetadata;
  }

  // Active-memory context can be prepended before the real user prompt; strip
  // that known block before the generic context-header truncation below.
  const afterActiveMemoryContext = cleaned.replace(
    /^Context:[ \t]*\n<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>\s*/gm,
    "",
  );
  strippedInjectedContext ||= afterActiveMemoryContext !== cleaned;
  cleaned = afterActiveMemoryContext;

  // Strip the marked channel-context header and everything after it.
  const untrustedLineMatch = CONTEXT_HEADER_RE.exec(cleaned);
  if (untrustedLineMatch) {
    strippedInjectedContext = true;
    cleaned = cleaned.slice(0, untrustedLineMatch.index);
  }

  // Strip the leading inbound-envelope bracket emitted by formatInboundEnvelope
  // (src/auto-reply/envelope.ts) after context metadata is removed. Real prompt
  // bodies often arrive as currentInboundContext followed by `[Channel ...]`.
  // The bracket precedes the user's body text; for non-direct envelopes the
  // body is prefixed with `<Sender>: ` and for direct fromMe with `(self): `,
  // so strip that too when the surviving label matches the formatter contract.
  cleaned = stripLeadingInboundEnvelope(cleaned, {
    allowAmbiguousMarkerFree: strippedInjectedContext,
  });

  cleaned = cleaned.replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/g, "");

  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned;
}
