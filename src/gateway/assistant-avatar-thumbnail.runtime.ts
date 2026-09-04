import { fileTypeFromBuffer } from "file-type";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createImageProcessor } from "../media/image-ops.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import {
  gatewayAvatarImageRevision,
  type GatewayAvatarImageSource,
} from "./assistant-avatar-cache.js";
import {
  createHttpImageRepresentation,
  resolveHttpImageMimeType,
  type HttpImageRepresentation,
} from "./http-image-response.js";

const AVATAR_THUMBNAIL_SIDE = 128;
const thumbnailCache = new Map<string, Promise<HttpImageRepresentation>>();

async function createAvatarThumbnail(
  source: GatewayAvatarImageSource,
): Promise<HttpImageRepresentation> {
  let body: Buffer;
  let contentType: string;
  if ("file" in source) {
    body = await readFileDescriptorBounded(source.file.fd, AVATAR_MAX_BYTES);
    contentType = resolveAvatarMime(source.file.path);
  } else {
    const comma = source.dataUrl.indexOf(",");
    const metadata = source.dataUrl.slice(5, comma).split(";");
    const mime = resolveHttpImageMimeType(metadata[0]);
    if (comma < 0 || !mime) {
      throw new Error("Unsupported avatar data URL");
    }
    const payload = source.dataUrl.slice(comma + 1);
    body = metadata.some((part) => part.toLowerCase() === "base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    contentType = mime;
    if (body.length > AVATAR_MAX_BYTES) {
      throw new Error("Avatar data URL exceeds size limit");
    }
  }
  // Preserve animation/vector bytes; Rastermill's PNG output contains only one frame.
  if (["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    const detectedMime = (await fileTypeFromBuffer(body))?.mime;
    // Rastermill's probe has no animation flag. RFC 9649 §2.7 puts the WebP
    // VP8X animation bit at byte 20: https://www.rfc-editor.org/rfc/rfc9649.html#section-2.7
    const animatedWebp =
      detectedMime === "image/webp" &&
      body.length >= 21 &&
      body.toString("ascii", 12, 16) === "VP8X" &&
      (body.readUInt8(20) & 0x02) !== 0;
    if (detectedMime === "image/apng" || animatedWebp) {
      return createHttpImageRepresentation(body, contentType);
    }
    body = (
      await createImageProcessor().encode(body, {
        format: "png",
        resize: { maxSide: AVATAR_THUMBNAIL_SIDE, enlarge: false },
      })
    ).data;
    contentType = "image/png";
  }
  return createHttpImageRepresentation(body, contentType);
}

/** Caller retains descriptor ownership until this shared read has settled. */
export async function readGatewayAvatarThumbnail(
  source: GatewayAvatarImageSource,
): Promise<HttpImageRepresentation> {
  const revision = gatewayAvatarImageRevision(source);
  let pending = thumbnailCache.get(revision);
  if (!pending) {
    pending = createAvatarThumbnail(source);
  }
  thumbnailCache.delete(revision);
  thumbnailCache.set(revision, pending);
  // Original animation/vector bytes remain bounded by AVATAR_MAX_BYTES; limit
  // both retained representations and concurrent same-source encoding work.
  pruneMapToMaxSize(thumbnailCache, 4);
  try {
    return await pending;
  } catch (error) {
    if (thumbnailCache.get(revision) === pending) {
      thumbnailCache.delete(revision);
    }
    throw error;
  }
}
