import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../../agents/internal-runtime-context.js";
import { escapeRegExp } from "../../shared/regexp.js";
import { findCodeRegions } from "../../shared/text/code-regions.js";

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
const INTERNAL_RUNTIME_MARKER_LINE_PATTERNS = [
  "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
  "<<<END_UNTRUSTED_CHILD_RESULT>>>",
].map(
  (marker) => new RegExp(`(?:^|\\r?\\n)[ \\t]*${escapeRegExp(marker)}[ \\t]*(?=\\r?\\n|$)`, "g"),
);
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = escapeRegExp(INTERNAL_RUNTIME_CONTEXT_BEGIN);
// Runtime producers escape nested opening delimiters. Consume every closing
// marker before the next opener so marker-shaped payload text cannot escape.
const INLINE_INTERNAL_RUNTIME_CONTEXT_BLOCK_RE = new RegExp(
  `${ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN}(?:(?!${ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN})[\\s\\S])*${escapeRegExp(INTERNAL_RUNTIME_CONTEXT_END)}`,
  "g",
);
const PROMPT_DATA_TAG_NAMES = ["prompt-data", "untrusted-text"] as const;

function isStandaloneMarkerAt(text: string, marker: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset + marker.length);
  return (
    text.slice(lineStart, offset).trim().length === 0 &&
    text.slice(offset + marker.length, lineEnd === -1 ? undefined : lineEnd).trim().length === 0
  );
}

function stripInlineInternalRuntimeContextBlocks(text: string): string {
  // Keep standalone blocks with their canonical stripping owner and preserve
  // ordinary prose that only mentions a single internal marker.
  return text.replace(
    INLINE_INTERNAL_RUNTIME_CONTEXT_BLOCK_RE,
    (block, offset: number, value: string) =>
      isStandaloneMarkerAt(value, INTERNAL_RUNTIME_CONTEXT_BEGIN, offset) ? block : "",
  );
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
  // Both removable tag forms contain "<", including headers followed by an opener.
  if (!text.includes("<")) {
    return text;
  }
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
  let stripped = stripInternalRuntimeContext(
    unwrapPromptDataWrapperLines(stripInlineInternalRuntimeContextBlocks(text))
      .replace(INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
      .replace(INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
      .replace(INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, ""),
    { preserveSurroundingWhitespace: true },
  );
  // Global replacement resets lastIndex, including between nested payload fields.
  for (const pattern of INTERNAL_RUNTIME_MARKER_LINE_PATTERNS) {
    stripped = stripped.replace(pattern, "");
  }
  return stripPlainTextToolCallBlocks(stripped, { resolveProtectedRanges: findCodeRegions });
}
