import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { collapseInlineHorizontalWhitespace } from "./reply-inline-whitespace.js";

const INLINE_SIMPLE_COMMAND_ALIASES = new Map<string, string>([
  ["/help", "/help"],
  ["/commands", "/commands"],
  ["/whoami", "/whoami"],
  ["/id", "/whoami"],
]);
const INLINE_SIMPLE_COMMAND_RE = /(?:^|\s)\/(help|commands|whoami|id)(?=$|\s|:)/i;

const INLINE_STATUS_RE = /(?:^|\s)\/status(?=$|\s|:)(?:\s*:\s*)?/gi;

export function extractInlineSimpleCommand(body?: string): {
  command: string;
  cleaned: string;
} | null {
  if (!body) {
    return null;
  }
  const match = body.match(INLINE_SIMPLE_COMMAND_RE);
  if (!match || match.index === undefined) {
    return null;
  }
  const alias = `/${normalizeLowercaseStringOrEmpty(match[1])}`;
  const command = INLINE_SIMPLE_COMMAND_ALIASES.get(alias);
  if (!command) {
    return null;
  }
  const cleaned = collapseInlineHorizontalWhitespace(body.replace(match[0], " ")).trim();
  return { command, cleaned };
}

export function stripInlineStatus(body: string): {
  cleaned: string;
  didStrip: boolean;
} {
  const trimmed = body.trim();
  if (!trimmed) {
    return { cleaned: "", didStrip: false };
  }
  // Use [^\S\n]+ instead of \s+ to only collapse horizontal whitespace,
  // preserving newlines so multi-line messages keep their paragraph structure.
  const cleaned = collapseInlineHorizontalWhitespace(trimmed.replace(INLINE_STATUS_RE, " ")).trim();
  return { cleaned, didStrip: cleaned !== trimmed };
}
