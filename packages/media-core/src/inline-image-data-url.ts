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
  {
    mime: "image/bmp",
    matches: (buffer) => buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d,
  },
];

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heis", "heim", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const IMAGE_SIGNATURE_PREFIX_BASE64_CHARS = 128;
const INLINE_IMAGE_DATA_URL_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function startsWithDataUrl(value: string): boolean {
  return (
    value.slice(0, INLINE_IMAGE_DATA_URL_PREFIX.length).toLowerCase() ===
    INLINE_IMAGE_DATA_URL_PREFIX
  );
}

function sniffIsoBmffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    return undefined;
  }
  const brands = [buffer.subarray(8, 12).toString("ascii")];
  for (let offset = 16; offset + 4 <= buffer.length; offset += 4) {
    brands.push(buffer.subarray(offset, offset + 4).toString("ascii"));
  }
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) {
    return "image/heic";
  }
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) {
    return "image/heif";
  }
  return undefined;
}

/** Sniffs supported inline image formats from decoded bytes. */
export function sniffInlineImageMime(buffer: Buffer): string | undefined {
  return (
    IMAGE_SIGNATURES.find((signature) => signature.matches(buffer))?.mime ??
    sniffIsoBmffImageMime(buffer)
  );
}

function isImageMimeType(value: string): boolean {
  return value.trim().toLowerCase().startsWith("image/");
}

export type SanitizedInlineImageBase64 = {
  mimeType: string;
  base64: string;
};

/** Canonicalizes trusted inline image base64 and rejects malformed or non-image payloads. */
export function sanitizeInlineImageBase64(params: {
  mimeType: string;
  base64: string;
}): SanitizedInlineImageBase64 | undefined {
  if (!isImageMimeType(params.mimeType)) {
    return undefined;
  }
  const canonicalPayload = canonicalizeBase64(params.base64);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffInlineImageMime(
    Buffer.from(canonicalPayload.slice(0, IMAGE_SIGNATURE_PREFIX_BASE64_CHARS), "base64"),
  );
  if (!sniffedMimeType) {
    return undefined;
  }
  return {
    mimeType: sniffedMimeType,
    base64: canonicalPayload,
  };
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
  return (
    mimeType !== undefined &&
    isImageMimeType(mimeType) &&
    options.some((part) => part.toLowerCase() === "base64")
  );
}

function sanitizeInlineImageDataUrlWithAllowedMimes(
  imageUrl: string,
  allowedMimes?: Set<string>,
): string | undefined {
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

  const [mimeType] = parsed.metadata;
  const sanitized = sanitizeInlineImageBase64({
    mimeType: mimeType ?? "",
    base64: parsed.payload,
  });
  if (!sanitized) {
    return undefined;
  }
  if (allowedMimes && !allowedMimes.has(sanitized.mimeType)) {
    return undefined;
  }
  // Trust the byte signature over caller-supplied metadata before reinlining.
  return `data:${sanitized.mimeType};base64,${sanitized.base64}`;
}

/**
 * Canonicalizes trusted inline image data URLs for persistence.
 * Accepts every image signature supported by `sanitizeInlineImageBase64`.
 */
export function sanitizeInlineImageDataUrlForStorage(imageUrl: string): string | undefined {
  return sanitizeInlineImageDataUrlWithAllowedMimes(imageUrl);
}

/** Canonicalizes provider-safe inline image data URLs and rejects unsupported formats. */
export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeInlineImageDataUrlWithAllowedMimes(imageUrl, INLINE_IMAGE_DATA_URL_MIMES);
}
