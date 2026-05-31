import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl } from "../media/inline-image-data-url.js";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

type JsonRecord = Record<string, unknown>;

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
    const imageUrl = sanitizeSharedInlineImageDataUrl(value.image_url);
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
  return sanitizeSharedInlineImageDataUrl(imageUrl);
}
