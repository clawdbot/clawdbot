import {
  projectMediaFacts,
  type MediaFact,
  type MediaFactLegacyProjection,
} from "../../media/media-facts.js";

/** Input media item used by channel outbound payload builders. */
export type MediaPayloadInput = Required<Pick<MediaFact, "path">> & Pick<MediaFact, "contentType">;

/**
 * Legacy-compatible media payload shape consumed by plugin send helpers.
 * @deprecated Inbound contexts use `media`; outbound replies use lowercase
 * `ReplyPayload.mediaUrl`/`mediaUrls`.
 */
export type MediaPayload = Omit<MediaFactLegacyProjection, "MediaTranscribedIndexes">;

/**
 * Builds single-item and list legacy media fields.
 * @deprecated Inbound contexts use `media`; outbound replies use lowercase
 * `ReplyPayload.mediaUrl`/`mediaUrls`.
 */
export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  const projected = projectMediaFacts(mediaList, "compact");
  return opts?.preserveMediaTypeCardinality
    ? {
        ...projected,
        MediaTypes: mediaList.map((entry) => entry.contentType ?? ""),
      }
    : projected;
}
