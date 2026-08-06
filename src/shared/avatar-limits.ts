// Browser-safe avatar payload limits shared by Gateway and Control UI projections.

/** Maximum avatar payload size accepted by local file and Gateway upload paths. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// SVG has the longest MIME prefix among supported local avatar formats.
const MAX_AVATAR_DATA_URL_PREFIX_LENGTH = "data:image/svg+xml;base64,".length;

/** Maximum encoded length of a supported local avatar at AVATAR_MAX_BYTES. */
export const AVATAR_MAX_DATA_URL_CHARS =
  Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + MAX_AVATAR_DATA_URL_PREFIX_LENGTH;

const AVATAR_IMAGE_DATA_URL_RE = /^data:image\//i;

/** Accepts image data URLs that fit the Gateway and Control UI payload boundary. */
export function isRenderableAvatarImageDataUrl(value: string): boolean {
  return value.length <= AVATAR_MAX_DATA_URL_CHARS && AVATAR_IMAGE_DATA_URL_RE.test(value);
}
