import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  extractJsonNullableStringFieldPrefix,
  extractJsonNumberFieldPrefix,
  extractJsonStringFieldPrefix,
  readNonBlankStringPreservingWhitespace,
} from "./session-transcript-json.js";

export type TranscriptRecord = {
  byteLength: number;
  id?: string;
  /** Private provenance; synthesized oversized placeholders must never qualify. */
  recoveredImageData?: true;
  record: Record<string, unknown>;
};

export const MAX_TRANSCRIPT_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS = 64 * 1024;
const MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES = 32;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";

export function isOversizedTranscriptLine(line: string): boolean {
  return Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_PARSE_LINE_BYTES;
}

function isJsonObjectFieldToken(source: string, tokenIndex: number): boolean {
  for (let index = tokenIndex - 1; index >= 0; index--) {
    const char = source.charAt(index);
    if (/\s/.test(char)) {
      continue;
    }
    return char === "{" || char === ",";
  }
  return true;
}

function extractJsonStringFieldWindow(
  source: string,
  field: string,
  startIndex = 0,
  endIndex = source.length,
): string | undefined {
  const fieldToken = JSON.stringify(field);
  let searchIndex = startIndex;
  while (searchIndex < endIndex) {
    const tokenIndex = source.indexOf(fieldToken, searchIndex);
    if (tokenIndex < 0 || tokenIndex >= endIndex) {
      return undefined;
    }
    searchIndex = tokenIndex + fieldToken.length;
    if (!isJsonObjectFieldToken(source, tokenIndex)) {
      continue;
    }
    const match = /^\s*:\s*"((?:\\.|[^"\\])*)"/.exec(source.slice(searchIndex, endIndex));
    if (!match) {
      continue;
    }
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as unknown;
      return readNonBlankStringPreservingWhitespace(decoded);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractJsonStringFieldSuffix(source: string, field: string): string | undefined {
  const startIndex = Math.max(0, source.length - OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS);
  return extractJsonStringFieldWindow(source, field, startIndex);
}

function recoverOversizedMultimodalTranscriptRecord(
  line: string,
): Record<string, unknown> | undefined {
  const markerPrefix = "__openclaw_omitted_image_";
  if (line.includes(markerPrefix)) {
    return undefined;
  }
  const payloads: Array<{ start: number; end: number; marker: string; bytes: number }> = [];
  const dataPattern = /"data"\s*:\s*"/g;
  let scannedCandidates = 0;
  for (let dataMatch = dataPattern.exec(line); dataMatch; dataMatch = dataPattern.exec(line)) {
    if (!isJsonObjectFieldToken(line, dataMatch.index)) {
      continue;
    }
    if (++scannedCandidates > MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES) {
      return undefined;
    }
    const start = dataMatch.index + dataMatch[0].length;
    let end = start;
    let padding = 0;
    let valid = true;
    for (; end < line.length && line.charCodeAt(end) !== 34; end++) {
      const code = line.charCodeAt(end);
      if (code === 92) {
        valid = false;
        end++;
        continue;
      }
      if (!valid) {
        continue;
      }
      if (code === 61) {
        if (++padding > 2) {
          valid = false;
        }
      } else if (
        padding > 0 ||
        (((code | 32) < 97 || (code | 32) > 122) &&
          (code < 48 || code > 57) &&
          code !== 43 &&
          code !== 47)
      ) {
        valid = false;
      }
    }
    if (end >= line.length) {
      return undefined;
    }
    dataPattern.lastIndex = end + 1;
    if (!valid || (end - start) % 4 !== 0) {
      continue;
    }
    payloads.push({
      start,
      end,
      marker: `${markerPrefix}${payloads.length}__`,
      bytes: ((end - start) * 3) / 4 - padding,
    });
  }
  if (payloads.length === 0) {
    return undefined;
  }
  try {
    const parseBoundedRedaction = (
      selected: typeof payloads,
    ): Record<string, unknown> | undefined => {
      const bytes = selected.reduce(
        (remaining, payload) => remaining - (payload.end - payload.start - payload.marker.length),
        Buffer.byteLength(line, "utf8"),
      );
      if (selected.length === 0 || bytes > MAX_TRANSCRIPT_PARSE_LINE_BYTES) {
        return undefined;
      }
      let cursor = 0;
      const parts: string[] = [];
      for (const payload of selected) {
        parts.push(line.slice(cursor, payload.start), payload.marker);
        cursor = payload.end;
      }
      parts.push(line.slice(cursor));
      const markers = new Set(selected.map((payload) => payload.marker));
      const parsed = JSON.parse(parts.join(""), (_key: string, value: unknown) => {
        if (typeof value === "string" && value.startsWith(markerPrefix) && !markers.delete(value)) {
          throw new Error("invalid transcript image recovery marker");
        }
        return value;
      }) as unknown;
      if (markers.size > 0 || !isRecord(parsed)) {
        return undefined;
      }
      return parsed;
    };
    const imageDataOwners = (block: Record<string, unknown>): Record<string, unknown>[] => {
      const source = asOptionalRecord(block.source);
      return source?.type === "base64" ? [block, source] : [block];
    };

    // Parse all bounded candidates once, then classify image ownership from real JSON structure.
    const preview = parseBoundedRedaction(payloads);
    const previewContent = asOptionalRecord(preview?.message)?.content;
    if (!Array.isArray(previewContent)) {
      return undefined;
    }
    const payloadByMarker = new Map(payloads.map((payload) => [payload.marker, payload]));
    const imageMarkers = new Set<string>();
    for (const candidate of previewContent) {
      if (!isRecord(candidate) || candidate.type !== "image") {
        continue;
      }
      for (const owner of imageDataOwners(candidate)) {
        if (typeof owner.data !== "string") {
          continue;
        }
        if (!payloadByMarker.has(owner.data) || imageMarkers.has(owner.data)) {
          return undefined;
        }
        imageMarkers.add(owner.data);
      }
    }
    if (imageMarkers.size === 0) {
      return undefined;
    }

    // Rebuild from the original line so document and metadata bytes remain untouched.
    const imagePayloads = payloads.filter((payload) => imageMarkers.has(payload.marker));
    const record = parseBoundedRedaction(imagePayloads);
    const content = asOptionalRecord(record?.message)?.content;
    if (!record || !Array.isArray(content)) {
      return undefined;
    }
    const remaining = new Map(imagePayloads.map((payload) => [payload.marker, payload]));
    for (const block of content) {
      if (!isRecord(block) || block.type !== "image") {
        continue;
      }
      let imageBytes: number | undefined;
      for (const owner of imageDataOwners(block)) {
        if (typeof owner.data !== "string") {
          continue;
        }
        const payload = remaining.get(owner.data);
        if (!payload) {
          return undefined;
        }
        remaining.delete(payload.marker);
        imageBytes ??= payload.bytes;
        delete owner.data;
      }
      if (imageBytes !== undefined) {
        block.omitted = true;
        block.bytes = imageBytes;
      }
    }
    // Parsed numeric spellings can expand, so both archive readers need the final UTF-8 bound.
    return remaining.size === 0 && jsonUtf8Bytes(record) <= MAX_TRANSCRIPT_PARSE_LINE_BYTES
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseTranscriptRecord(line: string): TranscriptRecord | null {
  const oversized = isOversizedTranscriptLine(line);
  const recoveredRecord = oversized ? recoverOversizedMultimodalTranscriptRecord(line) : undefined;
  if (!oversized || recoveredRecord) {
    try {
      const record = recoveredRecord ?? (JSON.parse(line) as unknown);
      if (!isRecord(record)) {
        return null;
      }
      const id = readNonBlankStringPreservingWhitespace(record.id);
      return {
        byteLength: Buffer.byteLength(line, "utf8"),
        ...(id ? { id } : {}),
        ...(recoveredRecord ? { recoveredImageData: true as const } : {}),
        record,
      };
    } catch {
      return null;
    }
  }
  const prefix = line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
  const messageMatch = /"message"\s*:/.exec(prefix);
  const recordPrefix = messageMatch ? prefix.slice(0, messageMatch.index) : prefix;
  const id = extractJsonStringFieldPrefix(prefix, "id");
  const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
  const type = extractJsonStringFieldPrefix(prefix, "type");
  const timestamp =
    extractJsonStringFieldPrefix(recordPrefix, "timestamp") ??
    extractJsonNumberFieldPrefix(recordPrefix, "timestamp");
  const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
  const idempotencyKey =
    extractJsonStringFieldPrefix(prefix, "idempotencyKey") ??
    extractJsonStringFieldSuffix(line, "idempotencyKey");
  const record: Record<string, unknown> = {
    ...(type ? { type } : {}),
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      role,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      content: [{ type: "text", text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER }],
      __openclaw: { truncated: true, reason: "oversized" },
    },
  };
  return {
    byteLength: Buffer.byteLength(line, "utf8"),
    ...(id ? { id } : {}),
    record,
  };
}
