import {
  projectMediaFacts,
  type MediaFact,
  type MediaFactLegacyProjection,
} from "../../media/media-facts.js";

/** Input media item used by channel outbound payload builders. */
export type MediaPayloadInput = Required<Pick<MediaFact, "path">> & Pick<MediaFact, "contentType">;

/** Legacy-compatible media payload shape consumed by plugin send helpers. */
export type MediaPayload = Omit<MediaFactLegacyProjection, "MediaTranscribedIndexes">;

/** Builds single-item and list media fields for channel outbound helpers. */
export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  return projectMediaFacts(mediaList, opts?.preserveMediaTypeCardinality ? "aligned" : "compact");
}
