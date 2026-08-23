import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getAiTransportHost } from "../host.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

const PROVIDER_TOOL_RESULT_MAX_CHARS = 8000;
const IMAGE_TOOL_RESULT_TYPES = new Set(["image", "image_url", "input_image"]);
const AUDIO_TOOL_RESULT_TYPES = new Set(["audio", "input_audio", "output_audio"]);
const MEDIA_ONLY_TOOL_RESULT_TYPES = new Set([
  ...IMAGE_TOOL_RESULT_TYPES,
  ...AUDIO_TOOL_RESULT_TYPES,
]);
const INLINE_DATA_URI_PATTERN =
  /(^|[^A-Za-z0-9_])data:([a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^,;"'\s]+|;base64)*,[^\s"'<>)]+)/gi;
const MIME_KEY_CANDIDATES = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
];
const TEXTUAL_MIME_PATTERN =
  /^(?:text\/|application\/(?:json|ld\+json|x-ndjson|xml|javascript|x-www-form-urlencoded)|[^/]+\/[^+]+\+(?:json|xml)$)/i;
const OPAQUE_OR_BINARY_FIELD_RE = /^(?:blob|buffer|bytes|encrypted_content|encrypted_stdout)$/i;

function readMimeType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of MIME_KEY_CANDIDATES) {
    const mimeType = value[key];
    if (typeof mimeType === "string" && mimeType.trim().length > 0) {
      return mimeType;
    }
  }
  return undefined;
}

function isBinaryMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? !TEXTUAL_MIME_PATTERN.test(normalized) : false;
}

function describeOmittedValue(value: unknown, label: string): string {
  const length = typeof value === "string" ? value.length : JSON.stringify(value)?.length;
  return length ? `[${label} omitted: ${length} chars]` : `[${label} omitted]`;
}

function redactInlineDataUris(value: string): string {
  return value.replace(
    INLINE_DATA_URI_PATTERN,
    (_match, prefix: string, uri: string) => `${prefix}[inline data URI: ${uri.length} chars]`,
  );
}

function redactStructuredTextValue(value: string): string {
  const host = getAiTransportHost();
  const redacted = host.redactToolPayloadText(value);
  const trimmed = redacted.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redacted;
  }
  try {
    const redactedWrapper = host.redactSecrets({ structuredTextValue: JSON.parse(redacted) });
    return JSON.stringify(redactedWrapper.structuredTextValue);
  } catch {
    return redacted;
  }
}

function stringifyStructuredBlock(block: Record<string, unknown>): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const redactedWrapper = getAiTransportHost().redactSecrets({ structuredToolResult: block });
    const redactedBlock = redactedWrapper.structuredToolResult;
    const serialized = JSON.stringify(
      redactedBlock,
      function structuredToolResultReplacer(this: unknown, key, value) {
        if (OPAQUE_OR_BINARY_FIELD_RE.test(key)) {
          return `[omitted ${key}]`;
        }
        if (key === "data") {
          const mimeType = readMimeType(this);
          if (mimeType && isBinaryMimeType(mimeType)) {
            return describeOmittedValue(value, "binary data");
          }
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (typeof value === "string") {
          return redactInlineDataUris(redactStructuredTextValue(value));
        }
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
          return undefined;
        }
        if (!value || typeof value !== "object") {
          return value;
        }
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
        return value;
      },
    );
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    return serialized;
  } catch {
    return undefined;
  }
}

function truncateProviderToolText(text: string): string {
  if (text.length <= PROVIDER_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, PROVIDER_TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

/** Media metadata alone is not an attachment; provider emitters need inline bytes. */
export function hasMediaPayload(
  block: unknown,
): block is Record<string, unknown> & { data: string } {
  return isRecord(block) && typeof block.data === "string" && block.data.trim().length > 0;
}

/** Image metadata alone is not an attachment; provider emitters need inline bytes. */
export function isImageWithMediaPayload<T>(block: T): block is T & { type: "image"; data: string } {
  return isRecord(block) && block.type === "image" && hasMediaPayload(block);
}

export function describeToolResultMediaPlaceholder(blocks: readonly unknown[]): string | undefined {
  let hasImage = false;
  let hasAudio = false;

  for (const block of blocks) {
    if (!hasMediaPayload(block)) {
      continue;
    }
    const record = block;
    const type = typeof record.type === "string" ? record.type : undefined;
    const mimeType = readMimeType(record);

    if (
      (type && IMAGE_TOOL_RESULT_TYPES.has(type)) ||
      mimeType?.toLowerCase().startsWith("image/")
    ) {
      hasImage = true;
    }
    if (
      (type && AUDIO_TOOL_RESULT_TYPES.has(type)) ||
      mimeType?.toLowerCase().startsWith("audio/")
    ) {
      hasAudio = true;
    }
  }

  if (hasImage && hasAudio) {
    return "(see attached media)";
  }
  if (hasAudio) {
    return "(see attached audio)";
  }
  if (hasImage) {
    return "(see attached image)";
  }
  return undefined;
}

export function extractToolResultBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  if (typeof record.type === "string" && MEDIA_ONLY_TOOL_RESULT_TYPES.has(record.type)) {
    return undefined;
  }
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text : "";
    return text ? sanitizeSurrogates(text) : undefined;
  }
  const structured = stringifyStructuredBlock(record);
  return structured ? sanitizeSurrogates(truncateProviderToolText(structured)) : undefined;
}

export function extractToolResultText(blocks: readonly unknown[]): string {
  const explicitTexts: string[] = [];
  const structuredTexts: string[] = [];
  for (const block of blocks) {
    const text = extractToolResultBlockText(block);
    if (!text) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      explicitTexts.push(text);
    } else {
      structuredTexts.push(text);
    }
  }
  if (explicitTexts.length > 0) {
    return sanitizeSurrogates(explicitTexts.join("\n"));
  }
  return sanitizeSurrogates(truncateProviderToolText(structuredTexts.join("\n")));
}
