// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { extractImageContentFromSource, normalizeMimeType } from "../media/input-files.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

function isHeicInput(params: { mime?: string; fileName?: string }): boolean {
  const mime = normalizeMimeType(params.mime);
  if (mime && HEIC_MIME_RE.test(mime)) {
    return true;
  }
  const fileName = params.fileName?.trim();
  return Boolean(fileName && HEIC_EXT_RE.test(fileName));
}

/** Normalizes image bytes before provider execution, converting HEIC/HEIF inputs to JPEG. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  if (!isHeicInput(params)) {
    return { buffer: params.buffer, mime: params.mime };
  }
  const sourceMime = normalizeMimeType(params.mime) ?? "image/heic";
  // Reuse input-file extraction so HEIC conversion follows the same MIME and size guards.
  const image = await extractImageContentFromSource(
    {
      type: "base64",
      data: params.buffer.toString("base64"),
      mediaType: sourceMime,
    },
    {
      allowUrl: false,
      allowedMimes: new Set([sourceMime.toLowerCase(), "image/heic", "image/heif", "image/jpeg"]),
      maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES.image,
      maxRedirects: 0,
      timeoutMs: 0,
    },
  );
  return {
    buffer: Buffer.from(image.data, "base64"),
    mime: image.mimeType,
  };
}
