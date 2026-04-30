/**
 * Sanitize model output for plain-text messaging surfaces.
 *
 * LLMs occasionally produce HTML tags (`<br>`, `<b>`, `<i>`, etc.) that render
 * correctly on web but appear as literal text on WhatsApp, Signal, SMS, and IRC.
 *
 * Converts common inline HTML to lightweight-markup equivalents used by
 * WhatsApp/Signal/Telegram and strips any remaining tags.
 *
 * @see https://github.com/openclaw/openclaw/issues/31884
 * @see https://github.com/openclaw/openclaw/issues/18558
 */

const INTERNAL_RUNTIME_SCAFFOLDING_TAGS = ["system-reminder", "previous_response"] as const;
const INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN = INTERNAL_RUNTIME_SCAFFOLDING_TAGS.join("|");
const INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE = new RegExp(
  `<\\s*(${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`,
  "gi",
);
const INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE = new RegExp(
  `<\\s*(?:${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*\\/\\s*>`,
  "gi",
);
const INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*>`,
  "gi",
);
const HTML_TAG_RE = /<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi;

function stripRemainingHtmlTags(text: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(HTML_TAG_RE, "");
  } while (current !== previous);
  return current;
}

export function stripInternalRuntimeScaffolding(text: string): string {
  return text
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
}

/**
 * Convert common HTML tags to their plain-text/lightweight-markup equivalents
 * and strip anything that remains.
 *
 * The function is intentionally conservative — it only targets tags that models
 * are known to produce and avoids false positives on angle brackets in normal
 * prose (e.g. `a < b`).
 */
export function sanitizeForPlainText(text: string): string {
  const converted = stripInternalRuntimeScaffolding(text)
    // Preserve angle-bracket autolinks as plain URLs before tag stripping.
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1")
    // Line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Block elements → newlines
    .replace(/<\/?(p|div)>/gi, "\n")
    // Bold → WhatsApp/Signal bold
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*")
    // Italic → WhatsApp/Signal italic
    .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
    // Strikethrough → WhatsApp/Signal strikethrough
    .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~")
    // Inline code
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    // Headings → bold text with newline
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n")
    // List items → bullet points
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n");

  return stripRemainingHtmlTags(converted).replace(/\n{3,}/g, "\n\n");
}
