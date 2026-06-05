// Media Core module implements inline image data url behavior.
import { canonicalizeBase64 } from "./base64.js";

/** Prefix used to distinguish inline data URLs from remote/local image references. */
export const INLINE_IMAGE_DATA_URL_PREFIX = "data:";

const IMAGE_SIGNATURES: Array<{
  mime: string;
  matches: (buffer: Buffer) => boolean;
}> = [
  {
    mime: "image/png",
    matches: (buffer) =>
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    matches: (buffer) =>
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mime: "image/webp",
    matches: (buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
  },
  {
    mime: "image/gif",
    matches: (buffer) =>
      buffer.length >= 6 &&
      (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a"),
  },
];

function startsWithDataUrl(value: string): boolean {
  return (
    value.slice(0, INLINE_IMAGE_DATA_URL_PREFIX.length).toLowerCase() ===
    INLINE_IMAGE_DATA_URL_PREFIX
  );
}

/** Sniffs supported inline image formats from decoded bytes. */
export function sniffInlineImageMime(buffer: Buffer): string | undefined {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(buffer))?.mime;
}

function parseInlineImageDataUrl(value: string):
  | {
      metadata: string[];
      payload: string;
    }
  | undefined {
  if (!startsWithDataUrl(value)) {
    return { metadata: [], payload: value };
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  return {
    metadata: value
      .slice(INLINE_IMAGE_DATA_URL_PREFIX.length, commaIndex)
      .split(";")
      .map((part) => part.trim()),
    payload: value.slice(commaIndex + 1),
  };
}

function metadataAllowsImageBase64(metadata: string[]): boolean {
  const [mimeType, ...options] = metadata;
  const isImageMimeType = mimeType !== undefined && mimeType.toLowerCase().startsWith("image/");
  return isImageMimeType && options.some((part) => part.toLowerCase() === "base64");
}

/** Canonicalizes trusted inline image data URLs and rejects malformed or non-image payloads. */
export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  const parsed = parseInlineImageDataUrl(imageUrl);
  if (!parsed) {
    return undefined;
  }
  if (parsed.metadata.length === 0) {
    return imageUrl;
  }
  if (!metadataAllowsImageBase64(parsed.metadata)) {
    return undefined;
  }

  const canonicalPayload = canonicalizeBase64(parsed.payload);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffInlineImageMime(Buffer.from(canonicalPayload, "base64"));
  if (!sniffedMimeType) {
    return undefined;
  }
  // Trust the byte signature over caller-supplied metadata before reinlining.
  return `data:${sniffedMimeType};base64,${canonicalPayload}`;
}
