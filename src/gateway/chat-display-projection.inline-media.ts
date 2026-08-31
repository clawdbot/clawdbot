import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyMediaReferenceSource } from "../media/media-reference.js";

function isInlineDataUrl(value: string): boolean {
  return classifyMediaReferenceSource(value.trim()).isDataUrl;
}

// Every supported input shape writes the same top-level omission fact so
// stored-history consumers never need to rediscover which nested payload was removed.
export function redactResponsesInputImage(entry: Record<string, unknown>): boolean {
  if (entry.type !== "input_image") {
    return false;
  }
  let changed = false;
  if (
    typeof entry.image_url === "string" &&
    isInlineDataUrl(entry.image_url)
  ) {
    const imageUrl = entry.image_url;
    delete entry.image_url;
    entry.omitted = true;
    entry.bytes = Buffer.byteLength(imageUrl, "utf8");
    changed = true;
  }
  const imageUrl = readRecord(entry.image_url);
  if (imageUrl && typeof imageUrl.url === "string") {
    const url = imageUrl.url;
    if (isInlineDataUrl(url)) {
      const projectedImageUrl = { ...imageUrl };
      delete projectedImageUrl.url;
      entry.image_url = projectedImageUrl;
      entry.omitted = true;
      entry.bytes = Buffer.byteLength(url, "utf8");
      changed = true;
    }
  }
  const source = readRecord(entry.source);
  if (source) {
    const projectedSource = { ...source };
    let omittedBytes = 0;
    if (typeof source.url === "string" && isInlineDataUrl(source.url)) {
      omittedBytes += Buffer.byteLength(source.url, "utf8");
      delete projectedSource.url;
    }
    if (typeof source.data === "string") {
      omittedBytes += Buffer.byteLength(source.data, "utf8");
      delete projectedSource.data;
    }
    if (omittedBytes > 0) {
      entry.source = projectedSource;
      entry.omitted = true;
      entry.bytes = omittedBytes;
      changed = true;
    }
  }
  return changed;
}
