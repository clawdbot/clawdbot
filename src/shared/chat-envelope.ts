const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "iMessage",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;
function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

/** Removes recognized channel/timestamp prefixes while preserving user-authored bracket text. */
export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  // Only strip known generated envelopes; arbitrary `[name]` text may be part of the message.
  if (!looksLikeEnvelopeHeader(header)) {
    return text;
  }
  return text.slice(match[0].length);
}

/** Removes standalone message-id hint lines without touching inline user mentions. */
export function stripMessageIdHints(text: string): string {
  if (!/\[message_id:/i.test(text)) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}
