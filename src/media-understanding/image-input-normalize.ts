// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeInputImageBuffer } from "../media/input-files.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

const HEIC_MIME_RE = /^image\/hei[cf](?:-sequence)?$/i;
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
  // Keep owned bytes through the shared MIME and size guards; only API content needs base64.
  const image = await normalizeInputImageBuffer({
    buffer: params.buffer,
    mimeType: sourceMime,
    limits: {
      allowedMimes: new Set([sourceMime.toLowerCase(), "image/heic", "image/heif", "image/jpeg"]),
      maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES.image,
    },
  });
  return {
    buffer: image.buffer,
    mime: image.mimeType,
  };
}
