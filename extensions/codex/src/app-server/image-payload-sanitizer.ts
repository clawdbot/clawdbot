const DATA_URL_PREFIX = "data:";
const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, DATA_URL_PREFIX.length).toLowerCase() === DATA_URL_PREFIX;
}

function canonicalizeBase64(base64: string): string | undefined {
  let cleaned = "";
  let padding = 0;
  let sawPadding = false;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      cleaned += "=";
      continue;
    }
    const isBase64DataChar =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (sawPadding || !isBase64DataChar) {
      return undefined;
    }
    cleaned += base64[i];
  }
  if (!cleaned || cleaned.length % 4 !== 0) {
    return undefined;
  }
  return cleaned;
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

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
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

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeImageContentRecord(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  if (record.type === "image" && typeof record.data === "string") {
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "image/png";
    const imageUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${record.data}`);
    if (!imageUrl) {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const commaIndex = imageUrl.indexOf(",");
    const metadata = imageUrl.slice(DATA_URL_PREFIX.length, commaIndex);
    const mime = metadata.split(";")[0] ?? mimeType;
    return { ...record, mimeType: mime, data: imageUrl.slice(commaIndex + 1) };
  }

  if (record.type === "inputImage" && typeof record.imageUrl === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.imageUrl);
    return imageUrl
      ? { ...record, imageUrl }
      : { type: "inputText", text: invalidInlineImageText(label) };
  }

  if (record.type === "input_image" && typeof record.image_url === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.image_url);
    return imageUrl
      ? { ...record, image_url: imageUrl }
      : { type: "input_text", text: invalidInlineImageText(label) };
  }

  return undefined;
}

export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodexHistoryImagePayloads(entry, label)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }

  const imageRecord = sanitizeImageContentRecord(value, label);
  if (imageRecord) {
    return imageRecord as T;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = sanitizeCodexHistoryImagePayloads(child, label);
  }
  return next as T;
}
