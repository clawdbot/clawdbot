// Shared bounded JSONL metadata parsing for gateway transcript readers.
import { escapeRegExp } from "../shared/regexp.js";

/** Reads a nonblank transcript field while preserving its original whitespace. */
export function readNonBlankStringPreservingWhitespace(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Transcript readers repeatedly extract a fixed set of metadata fields from
// oversized JSONL prefixes. Keep the compiled regexes process-local instead of
// rebuilding them for every field on every oversized record.
const TRANSCRIPT_FIELD_REGEX_CACHE = new Map<
  string,
  { stringRe: RegExp; nullRe: RegExp; numberRe: RegExp }
>();

function getTranscriptFieldRegexes(field: string): {
  stringRe: RegExp;
  nullRe: RegExp;
  numberRe: RegExp;
} {
  let cached = TRANSCRIPT_FIELD_REGEX_CACHE.get(field);
  if (!cached) {
    const escapedField = escapeRegExp(field);
    cached = {
      stringRe: new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
      nullRe: new RegExp(`"${escapedField}"\\s*:\\s*null`),
      numberRe: new RegExp(`"${escapedField}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`),
    };
    TRANSCRIPT_FIELD_REGEX_CACHE.set(field, cached);
  }
  return cached;
}

export function extractJsonStringFieldPrefix(prefix: string, field: string): string | undefined {
  const match = getTranscriptFieldRegexes(field).stringRe.exec(prefix);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as unknown;
    return readNonBlankStringPreservingWhitespace(decoded);
  } catch {
    return undefined;
  }
}

export function extractJsonNullableStringFieldPrefix(
  prefix: string,
  field: string,
): string | null | undefined {
  if (getTranscriptFieldRegexes(field).nullRe.test(prefix)) {
    return null;
  }
  return extractJsonStringFieldPrefix(prefix, field);
}

export function extractJsonNumberFieldPrefix(prefix: string, field: string): number | undefined {
  const match = getTranscriptFieldRegexes(field).numberRe.exec(prefix);
  if (!match) {
    return undefined;
  }
  const decoded = Number(match[1]);
  return Number.isFinite(decoded) ? decoded : undefined;
}
