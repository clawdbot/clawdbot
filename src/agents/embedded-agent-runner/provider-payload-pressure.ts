/**
 * Estimates token pressure of a final provider request payload after every outbound transform.
 *
 * Admission measures the provider context before payload hooks run; this estimator measures the
 * serialized request body those hooks actually produce. It intentionally has no safety margin:
 * admission already applies its margin, so a raw estimate beyond the full context window means a
 * post-admission transform grew the request past anything admission could have accepted.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { estimateStringChars } from "../../utils/cjk-chars.js";

const PROVIDER_PAYLOAD_CHARS_PER_TOKEN = 4;
/** Flat rate for one media blob, matching the session estimator's per-image convention. */
const PROVIDER_PAYLOAD_MEDIA_BLOCK_TOKENS = 2_000;
/** Strings shorter than this are always counted as text, even under a media key. */
const PROVIDER_PAYLOAD_MEDIA_STRING_MIN_CHARS = 1_024;
const PROVIDER_PAYLOAD_KEY_OVERHEAD_TOKENS = 1;

/** Keys whose long string values are base64/data blobs rather than model-readable text. */
const PROVIDER_PAYLOAD_MEDIA_KEYS = new Set([
  "data",
  "b64_json",
  "file_data",
  "fileData",
  "image",
  "image_url",
  "imageUrl",
  "inline_data",
  "inlineData",
  "media",
  "bytes",
  "blob",
]);

function isMediaBlobString(key: string | undefined, value: string): boolean {
  if (value.length < PROVIDER_PAYLOAD_MEDIA_STRING_MIN_CHARS) {
    return false;
  }
  if (value.startsWith("data:")) {
    return true;
  }
  return key !== undefined && PROVIDER_PAYLOAD_MEDIA_KEYS.has(key);
}

function estimatePayloadValueTokenPressure(value: unknown, key: string | undefined): number {
  if (typeof value === "string") {
    return isMediaBlobString(key, value)
      ? PROVIDER_PAYLOAD_MEDIA_BLOCK_TOKENS
      : Math.ceil(estimateStringChars(value) / PROVIDER_PAYLOAD_CHARS_PER_TOKEN);
  }
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) {
      sum += estimatePayloadValueTokenPressure(item, undefined);
    }
    return sum;
  }
  if (isRecord(value)) {
    let sum = 0;
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sum +=
        PROVIDER_PAYLOAD_KEY_OVERHEAD_TOKENS +
        Math.ceil(entryKey.length / PROVIDER_PAYLOAD_CHARS_PER_TOKEN) +
        estimatePayloadValueTokenPressure(entryValue, entryKey);
    }
    return sum;
  }
  // Numbers, booleans, null, and undefined each serialize to a few characters.
  return 1;
}

/** Raw (unmargined) token estimate of the final outbound provider request payload. */
export function estimateProviderPayloadTokenPressure(payload: unknown): number {
  return Math.max(0, estimatePayloadValueTokenPressure(payload, undefined));
}
