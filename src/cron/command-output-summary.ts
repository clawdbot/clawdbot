import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { redactToolPayloadText } from "../logging/redact.js";

const MAX_PRESERVED_ACTION_LINES = 12;
const ACTION_LINE_PATTERNS = [
  /\b(device|user|verification|authorization|auth|login)\s+code\b/i,
  /\benter\s+(?:the\s+)?(?:code|verification code|device code)\b/i,
  /\bcopy\s+(?:this\s+)?code\b/i,
  /\bvisit\s+(?:https?:\/\/|www\.)/i,
  /\bopen\s+(?:https?:\/\/|www\.)/i,
  /\bbrowser\s+(?:to|at)\s+(?:https?:\/\/|www\.)/i,
  /\blog(?:\s|-)?in\s+(?:at|to|with)\b/i,
  /\bauth(?:enticate|orize)\s+(?:at|with|using)\b/i,
  /\bhttps?:\/\/[^\s]+\/(?:device|activate|login|oauth|authorize|auth)\b/i,
];
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const CODE_PATTERN = /\b[A-Z0-9]{4}(?:[- ][A-Z0-9]{3,8}){1,4}\b/g;
const UNSEPARATED_CODE_PATTERN = /\b[A-Z0-9]{6,12}\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:access|refresh)[_-]?token|api[_-]?key|token|password|secret)\s*([:=])\s*([^\s;&]+)/gi;

export function isCronCommandActionCriticalLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && ACTION_LINE_PATTERNS.some((pattern) => pattern.test(normalized)));
}

function normalizeLines(lines: string[] | undefined): string[] {
  const result: string[] = [];
  for (const line of lines ?? []) {
    const normalized = normalizeOptionalString(line);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
    if (result.length >= MAX_PRESERVED_ACTION_LINES) {
      break;
    }
  }
  return result;
}

export function buildCronCommandSummary(params: {
  stdout: string;
  stderr: string;
  preservedStdoutLines?: string[];
  preservedStderrLines?: string[];
}): string | undefined {
  const stdout = normalizeOptionalString(params.stdout);
  const stderr = normalizeOptionalString(params.stderr);
  const tail = stdout && stderr ? `stdout:\n${stdout}\n\nstderr:\n${stderr}` : (stdout ?? stderr);
  const preserved = [
    ...normalizeLines(params.preservedStdoutLines),
    ...normalizeLines(params.preservedStderrLines),
  ];
  if (preserved.length === 0) {
    return tail;
  }
  const missing = new Set(preserved);
  for (const line of tail?.split(/\r?\n/) ?? []) {
    const normalized = line.trim();
    // Check the short action list first so unrelated long lines never need hashing.
    if (preserved.includes(normalized)) {
      missing.delete(normalized);
      if (missing.size === 0) {
        return tail;
      }
    }
  }
  // Retain stream order and repeated actions from different output streams.
  const actionLines = preserved.filter((line) => missing.has(line));
  const actionBlock = `action-required output preserved:\n${actionLines.join("\n")}`;
  return tail ? `${actionBlock}\n\n${tail}` : actionBlock;
}

function cronCommandSummaryNeedsExternalRedaction(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }
  return summary
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith("action-required output preserved:") ||
        isCronCommandActionCriticalLine(line),
    );
}

export function redactCronCommandSummaryForExternalDelivery(
  summary: string | undefined,
): string | undefined {
  if (!summary || !cronCommandSummaryNeedsExternalRedaction(summary)) {
    return summary;
  }
  return summary
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part) || !isCronCommandActionCriticalLine(part)) {
        return part;
      }
      return redactToolPayloadText(part)
        .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
          return `${key}${separator}***`;
        })
        .replace(URL_PATTERN, "[redacted-url]")
        .replace(CODE_PATTERN, "[redacted-code]")
        .replace(UNSEPARATED_CODE_PATTERN, "[redacted-code]");
    })
    .join("");
}
