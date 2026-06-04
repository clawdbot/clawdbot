/**
 * Input media item used by channel outbound payload builders.
 */
export type MediaPayloadInput = {
  path: string;
  contentType?: string;
};

/**
 * Legacy-compatible media payload shape consumed by plugin send helpers.
 */
export type MediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

/**
 * Builds single-item and list media fields for channel outbound helpers.
 */
export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const rawMediaTypes = mediaList.map((media) => media.contentType ?? "");
  // Some callers need MediaTypes to stay aligned with MediaPaths, including
  // blank entries. Others use the compact legacy list of present content types.
  const mediaTypes = opts?.preserveMediaTypeCardinality
    ? rawMediaTypes
    : rawMediaTypes.filter((value): value is string => Boolean(value));
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
