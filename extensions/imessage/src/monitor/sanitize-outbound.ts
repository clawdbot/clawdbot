// Imessage plugin module implements sanitize outbound behavior.
import {
  findCodeRegions,
  isInsideCode,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
// Only a standalone role marker on its own line (a leaked turn boundary) — not
// any line that merely ends with the word "user/system/assistant:" in prose.
const ROLE_TURN_MARKER_RE = /^[ \t]*(?:user|system|assistant)\s*:\s*$/gm;

/**
 * Strip an internal-marker pattern from prose while leaving matches that fall
 * inside a fenced/indented/inline code region untouched: there a bare `user:`
 * mapping key or `#+#` line is the user's own content, not leaked scaffolding.
 * Regions are recomputed per call because the prior strip shifted later offsets.
 */
function stripMarkerOutsideCode(text: string, marker: RegExp): string {
  const codeRegions = findCodeRegions(text);
  return text.replace(marker, (match, offset: number) =>
    isInsideCode(offset, codeRegions) ? match : "",
  );
}

/**
 * Strip all assistant-internal scaffolding from outbound text before delivery.
 * Applies reasoning/thinking tag removal, memory tag removal, and
 * model-specific internal separator stripping.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  let cleaned = sanitizeAssistantVisibleText(text);

  cleaned = stripMarkerOutsideCode(cleaned, INTERNAL_SEPARATOR_RE);
  cleaned = stripMarkerOutsideCode(cleaned, ASSISTANT_ROLE_MARKER_RE);
  cleaned = stripMarkerOutsideCode(cleaned, ROLE_TURN_MARKER_RE);

  // Collapse excessive blank lines left after stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
