// Control UI helper converts picked avatar images into compact data URLs.
import { AVATAR_MAX_BYTES } from "../../../../src/shared/avatar-limits.js";

/** Uploaded avatars also mirror into prompt-injected IDENTITY.md. Keep their
    encoded form below the per-file bootstrap limit with room for identity text. */
const AVATAR_TARGET_SIZE = 96;
const AVATAR_EDITOR_MAX_DATA_URL_CHARS = 16_000;

function boundAvatarDataUrl(value: string | null): string | null {
  return value && value.length <= AVATAR_EDITOR_MAX_DATA_URL_CHARS ? value : null;
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(boundAvatarDataUrl(typeof reader.result === "string" ? reader.result : null)),
    );
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

/** Convert a picked image file into a data URL bounded for identity storage.
    Returns null when the file is not an image or cannot be encoded. */
export async function fileToAvatarDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/") || file.size > AVATAR_MAX_BYTES) {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AVATAR_TARGET_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return readFileAsDataUrl(file);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // toDataURL silently falls back to PNG when WebP is unsupported.
    const encoded = canvas.toDataURL("image/webp", 0.8);
    return boundAvatarDataUrl(
      encoded.startsWith("data:image/webp") ? encoded : canvas.toDataURL("image/png"),
    );
  } catch {
    // Non-rasterizable images (e.g. SVG without intrinsic size) pass through
    // unscaled; the size gate above still bounds the persisted payload.
    return readFileAsDataUrl(file);
  }
}
