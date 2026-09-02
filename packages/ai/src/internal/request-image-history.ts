import {
  appendRuntimeImageHistory,
  readRuntimeImageHistory,
  withRuntimeImageHistory,
} from "@openclaw/media-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type RequestImageFormat = "responses" | "chat" | "anthropic" | "google" | "mistral";

function requestImageSource(part: Record<string, unknown>, format: RequestImageFormat): unknown[] {
  if (format === "responses") {
    return [part.type, part.image_url];
  }
  if (format === "mistral") {
    return [part.type, part.imageUrl];
  }
  const source =
    format === "google" ? part.inlineData : format === "anthropic" ? part.source : part.image_url;
  const record = isRecord(source) ? source : {};
  return format === "google"
    ? [record.mimeType, record.data]
    : format === "anthropic"
      ? [part.type, record.type, record.media_type, record.data, record.url]
      : [part.type, record.url];
}

/** Bind provenance on fresh native parts to the source that payload hooks may replace. */
export function withRequestImageHistory<T extends Record<string, unknown>>(
  image: T,
  source: object,
  format: RequestImageFormat,
): T {
  const history = readRuntimeImageHistory(source);
  if (!history) {
    return image;
  }
  const encodedSource = requestImageSource(image, format);
  return withRuntimeImageHistory(image, history, (current) => {
    const currentSource = requestImageSource(current, format);
    return encodedSource.every((value, index) => value === currentSource[index]);
  });
}

/** Project private image origins only after the transport's final payload decisions. */
export function projectRequestImageHistory<T extends object>(
  request: T,
  format: RequestImageFormat,
): T {
  const messagesKey =
    format === "responses" ? "input" : format === "google" ? "contents" : "messages";
  const contentKey = format === "google" ? "parts" : "content";
  const textType = format === "responses" ? "input_text" : format === "google" ? undefined : "text";
  const imageType =
    format === "responses" ? "input_image" : format === "anthropic" ? "image" : "image_url";
  if (!isRecord(request) || !Array.isArray(request[messagesKey])) {
    return request;
  }

  let changed = false;
  const messages = request[messagesKey].map((message: unknown) => {
    if (!isRecord(message) || message.role !== "user") {
      return message;
    }
    const content = message[contentKey];
    if (!Array.isArray(content)) {
      return message;
    }
    const parts = content.filter(isRecord);
    const images = parts.filter((part) =>
      format === "google" ? isRecord(part.inlineData) : part.type === imageType,
    );
    const textPart = parts.find((part) => part.type === textType && typeof part.text === "string");
    const prompt = typeof textPart?.text === "string" ? textPart.text : "";
    const text = appendRuntimeImageHistory(prompt, images);
    if (text === prompt) {
      return message;
    }

    // Copy only the request projection: canonical messages and image hints remain
    // reusable for retries, while JSON serialization never sees the private hint.
    const projectedContent = content.slice();
    if (textPart) {
      projectedContent[content.indexOf(textPart)] = { ...textPart, text };
    } else {
      projectedContent.unshift({ ...(textType ? { type: textType } : {}), text });
    }
    changed = true;
    return { ...message, [contentKey]: projectedContent };
  });
  return changed ? { ...request, [messagesKey]: messages } : request;
}
