import { normalizeMimeType } from "@openclaw/media-core/mime";
import { fileTypeFromBuffer } from "file-type";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createImageProcessor } from "../media/image-ops.js";
import { isAvatarImageMimeType, isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import {
  gatewayAvatarImageRevision,
  type GatewayAvatarImageSource,
} from "./assistant-avatar-cache.js";
import {
  createHttpImageRepresentation,
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
    if (!isRenderableAvatarImageDataUrl(source.dataUrl)) {
      throw new Error("Unsupported avatar data URL");
    }
    // The validated data: scheme uses native byte decoding without network I/O.
    // Preserve charset parameters for unchanged SVG/XML representations.
    const response = await fetch(source.dataUrl);
    contentType = response.headers.get("content-type") ?? "";
    body = Buffer.from(await response.arrayBuffer());
    if (body.length > AVATAR_MAX_BYTES) {
      throw new Error("Avatar data URL exceeds size limit");
    }
  }
  const mime = normalizeMimeType(contentType);
  if (!mime || !isAvatarImageMimeType(mime)) {
    throw new Error("Unsupported avatar image type");
  }
  // Preserve animation/vector bytes; Rastermill's PNG output contains only one frame.
  if (["image/png", "image/jpeg", "image/webp"].includes(mime)) {
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
  const pending = thumbnailCache.get(revision) ?? createAvatarThumbnail(source);
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
