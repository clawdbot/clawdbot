import { canonicalizeBase64 } from "../media/base64.js";

const DATA_URL_PREFIX = "data:";
const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, DATA_URL_PREFIX.length).toLowerCase() === DATA_URL_PREFIX;
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  return undefined;
}

function sanitizeImageUrl(imageUrl: string): string | undefined {
  if (!startsWithDataUrl(imageUrl)) {
    return imageUrl;
  }
  const commaIndex = imageUrl.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }

  const metadata = imageUrl.slice(DATA_URL_PREFIX.length, commaIndex);
  const payload = imageUrl.slice(commaIndex + 1);
  const metadataParts = metadata.split(";").map((part) => part.trim());
  const declaredMimeType = metadataParts[0]?.toLowerCase();
  if (!declaredMimeType?.startsWith("image/")) {
    return undefined;
  }
  if (!metadataParts.slice(1).some((part) => part.toLowerCase() === "base64")) {
    return undefined;
  }

  const canonicalPayload = canonicalizeBase64(payload);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffImageMime(Buffer.from(canonicalPayload, "base64"));
  if (!sniffedMimeType) {
    return undefined;
  }
  return `data:${sniffedMimeType};base64,${canonicalPayload}`;
}

function invalidSnakeImage(): JsonRecord {
  return { type: "input_text", text: `[${IMAGE_OMITTED_TEXT}]` };
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  if (value.type === "input_image" && typeof value.image_url === "string") {
    const imageUrl = sanitizeImageUrl(value.image_url);
    return imageUrl ? { ...value, image_url: imageUrl } : invalidSnakeImage();
  }

  const next: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = sanitizeValue(child);
  }
  return next;
}

export function sanitizeResponsesImagePayload<T extends Record<string, unknown>>(params: T): T {
  if (!Array.isArray(params.input)) {
    return params;
  }
  return {
    ...params,
    input: sanitizeValue(params.input),
  };
}

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeImageUrl(imageUrl);
}

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}
