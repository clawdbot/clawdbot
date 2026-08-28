import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyMediaReferenceSource } from "../media/media-reference.js";

// Every supported input shape writes the same top-level omission fact so
// stored-history consumers never need to rediscover which nested payload was removed.
export function redactResponsesInputImage(entry: Record<string, unknown>): boolean {
  if (entry.type !== "input_image") {
    return false;
  }
  let changed = false;
  if (
    typeof entry.image_url === "string" &&
    classifyMediaReferenceSource(entry.image_url).isDataUrl
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
    if (classifyMediaReferenceSource(url).isDataUrl) {
      const projectedImageUrl = { ...imageUrl };
      delete projectedImageUrl.url;
      entry.image_url = projectedImageUrl;
      entry.omitted = true;
      entry.bytes = Buffer.byteLength(url, "utf8");
      changed = true;
    }
  }
  const source = readRecord(entry.source);
  if (source && typeof source.data === "string") {
    const data = source.data;
    const projectedSource = { ...source };
    delete projectedSource.data;
    entry.source = projectedSource;
    entry.omitted = true;
    entry.bytes = Buffer.byteLength(data, "utf8");
    changed = true;
  }
  return changed;
}
