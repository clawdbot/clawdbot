// Detects suspicious system-style tags in external content.
const BRACKETED_SYSTEM_TAG_RE = /\[\s*(System\s*Message|System|Assistant|Internal)\s*\]/gi;
const LINE_SYSTEM_PREFIX_RE = /^(\s*)System:(?=\s|$)/gim;

/**
 * Neutralize user-controlled strings that spoof internal system markers.
 */
export function sanitizeInboundSystemTags(input: string): string {
  return input
    .replace(BRACKETED_SYSTEM_TAG_RE, (_match, tag: string) => `(${tag})`)
    .replace(LINE_SYSTEM_PREFIX_RE, "$1System (untrusted):");
}
