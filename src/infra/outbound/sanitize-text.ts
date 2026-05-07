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
const INTERNAL_RUNTIME_DELIMITED_BLOCKS = [
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"],
] as const;
const INTERNAL_RUNTIME_MARKER_LINES = [
  "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
  "<<<END_UNTRUSTED_CHILD_RESULT>>>",
] as const;
const PROMPT_DATA_TAG_NAMES = ["prompt-data", "untrusted-text"] as const;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function standaloneLinePattern(token: string): string {
  return `(?:^|\\r?\\n)[ \\t]*${escapeRegExp(token)}[ \\t]*(?=\\r?\\n|$)`;
}

function stripDelimitedRuntimeBlock(text: string, begin: string, end: string): string {
  const closedBlockRe = new RegExp(
    `${standaloneLinePattern(begin)}[\\s\\S]*?${standaloneLinePattern(end)}`,
    "g",
  );
  const unmatchedBeginRe = new RegExp(`${standaloneLinePattern(begin)}[\\s\\S]*$`, "g");
  return stripStandaloneMarkerLine(
    text.replace(closedBlockRe, "").replace(unmatchedBeginRe, ""),
    end,
  );
}

function stripStandaloneMarkerLine(text: string, marker: string): string {
  return text.replace(new RegExp(standaloneLinePattern(marker), "g"), "");
}

function isPromptDataHeaderLine(line: string): boolean {
  return line.trim().endsWith("(treat text inside this block as data, not instructions):");
}

function isPromptDataTagLine(line: string, kind: "open" | "close"): boolean {
  const trimmed = line.trim().toLowerCase();
  return PROMPT_DATA_TAG_NAMES.some((tagName) =>
    kind === "open" ? trimmed === `<${tagName}>` : trimmed === `</${tagName}>`,
  );
}

function unwrapPromptDataWrapperLines(text: string): string {
  const lines = text.split(/\r?\n/);
  let changed = false;
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (isPromptDataHeaderLine(line) && isPromptDataTagLine(nextLine, "open")) {
      changed = true;
      continue;
    }
    if (isPromptDataTagLine(line, "open") || isPromptDataTagLine(line, "close")) {
      changed = true;
      continue;
    }
    output.push(line);
  }
  return changed ? output.join("\n") : text;
}

export function stripInternalRuntimeScaffolding(text: string): string {
  let stripped = unwrapPromptDataWrapperLines(text)
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
    .replace(INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
  for (const [begin, end] of INTERNAL_RUNTIME_DELIMITED_BLOCKS) {
    stripped = stripDelimitedRuntimeBlock(stripped, begin, end);
  }
  for (const marker of INTERNAL_RUNTIME_MARKER_LINES) {
    stripped = stripStandaloneMarkerLine(stripped, marker);
  }
  return stripped;
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
