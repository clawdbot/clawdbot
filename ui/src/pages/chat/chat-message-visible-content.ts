import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

/** Media output remains visible even when the user hides tool-call chrome. */
export function messageHasVisibleImage(message: unknown): boolean {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const type = normalizeLowercaseStringOrEmpty(asRecord(block)?.type);
    return (
      type === "image" ||
      type === "image_url" ||
      type === "input_image" ||
      type === "openclaw_pairing_qr"
    );
  });
}
