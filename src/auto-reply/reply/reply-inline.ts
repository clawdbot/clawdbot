// Resolves inline reply directives that alter a single reply turn.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { removeDirectiveSpan } from "./directive-parsing.js";

const INLINE_SIMPLE_COMMAND_ALIASES = new Map<string, string>([
  ["/help", "/help"],
  ["/commands", "/commands"],
  ["/whoami", "/whoami"],
  ["/id", "/whoami"],
]);
const INLINE_SIMPLE_COMMAND_RE = /(?<!\S)\/(help|commands|whoami|id)(?=$|\s|:)/i;
const INLINE_STATUS_RE = /(?<!\S)\/status(?=$|\s|:)(?:\s*:)?/i;

export function getStandaloneSlashCommandName(body: string): string | null {
  const match = body.trim().match(/^\/([^\s/:]+)(?::|\s|$)/u);
  return normalizeOptionalLowercaseString(match?.[1]) ?? null;
}

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
  const cleaned = removeDirectiveSpan(body, match.index, match.index + match[0].length);
  return { command, cleaned };
}

export function extractStatusDirective(body = ""): {
  cleaned: string;
  hasDirective: boolean;
} {
  const match = INLINE_STATUS_RE.exec(body);
  return {
    cleaned: match ? removeDirectiveSpan(body, match.index, match.index + match[0].length) : body,
    hasDirective: Boolean(match),
  };
}

export function stripInlineStatus(body: string): {
  cleaned: string;
  didStrip: boolean;
} {
  let cleaned = body;
  for (;;) {
    const parsed = extractStatusDirective(cleaned);
    if (!parsed.hasDirective) {
      return { cleaned, didStrip: cleaned !== body };
    }
    cleaned = parsed.cleaned;
  }
}
