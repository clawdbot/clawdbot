// Browser-safe redaction for tool details rendered by the Control UI.
import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  parseRedactPatternSource,
  readRedactMatch,
  redactPemBlock,
  type RedactMatch,
} from "../../../src/logging/redact-pattern-runtime.js";
import { DEFAULT_REDACT_PATTERNS } from "../../../src/logging/redact-patterns.js";

const URL_QUERY_PAIR_RE = /([?&])([^=&#\s]+)=([^&#\s"'<>]+)/gu;
const SECRET_DETAIL_PATTERNS = DEFAULT_REDACT_PATTERNS.map(
  (source) => new RegExp(...parseRedactPatternSource(source)),
);
const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\n\r]+/gi, "$1: [redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(["'])(\s*:\s*)"(?:\\.|[^"\\\r\n])*"/gi,
    '$1$2$3"[redacted]"',
  ],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(["'])(\s*:\s*)'(?:\\.|[^'\\\r\n])*'/gi,
    "$1$2$3'[redacted]'",
  ],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)["']?[^"',\s}]+/gi,
    "$1$2[redacted]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [
    /(^|[\s"'`=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g,
    "$1[redacted path]",
  ],
];

function redactToken(value: string): string {
  if (value.length <= 10) {
    return "***";
  }
  // A 6/4-shaped hint is intentionally idempotent: every non-separator
  // character is already inside the visible prefix or suffix budget.
  return `${sliceUtf16Safe(value, 0, 6)}...${sliceUtf16Safe(value, -4)}`;
}

function redactMatch({ match, groups, input, offset }: RedactMatch): string {
  const followingText = offset < 0 ? "" : input.slice(offset + match.length);
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match, "...redacted...");
  }
  const token = groups.findLast((group) => typeof group === "string" && group.length > 0) ?? match;
  // Replacement-template syntax can make a later pattern see only the leading `$` after an
  // earlier pattern has already masked the value. Preserve that literal shell marker.
  if (token === "$" && followingText.startsWith("`")) {
    return match;
  }
  const masked = redactToken(token);
  if (token === match) {
    return masked;
  }
  const tokenOffset = match.lastIndexOf(token);
  if (tokenOffset < 0) {
    return "***";
  }
  return `${match.slice(0, tokenOffset)}${masked}${match.slice(tokenOffset + token.length)}`;
}

function redactUrlQueryPairs(detail: string): string {
  return detail.replace(URL_QUERY_PAIR_RE, (match, boundary: string, key: string, value: string) =>
    isSensitiveUrlQueryParamName(key) ? `${boundary}${key}=${redactToken(value)}` : match,
  );
}

export function redactToolDetail(detail: string): string {
  let redacted = redactUrlQueryPairs(detail);
  for (const pattern of SECRET_DETAIL_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) =>
      redactMatch(readRedactMatch(args)),
    );
  }
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    redacted,
  );
}

export const redactToolPayloadText = redactToolDetail;
