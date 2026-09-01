// Qa Lab plugin module implements reply failure behavior.
const VISIBLE_REPLY_LEAK_PATTERNS = [
  /\bchecking thread context\b/i,
  /\bthread context thin\b/i,
  /\bpost a tight progress reply here\b/i,
  /\bposting a coordination nudge\b/i,
  /\bposted a short coordination reply\b/i,
  /\bnot inventing status\b/i,
];

const TOOL_BACKED_FAILURE_PATTERNS = [
  /\btool\s+[a-z0-9_.-]+\s+not found\b/i,
  /^status\s*[:=]\s*(?:blocked|failed)\b/im,
];

export function extractQaVisibleReplyLeakText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (VISIBLE_REPLY_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return trimmed;
  }
  return undefined;
}

export function extractQaFailureReplyText(message: {
  text: string;
  isError?: boolean;
}): string | undefined {
  const trimmed = message.text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (message.isError === true) {
    return trimmed;
  }
  const visibleReplyLeak = extractQaVisibleReplyLeakText(trimmed);
  if (visibleReplyLeak) {
    return visibleReplyLeak;
  }
  if (TOOL_BACKED_FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return trimmed;
  }
  return undefined;
}
