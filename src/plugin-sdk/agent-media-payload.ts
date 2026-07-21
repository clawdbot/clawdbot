import { projectMediaFacts, type MediaFactLegacyProjection } from "../media/media-facts.js";

export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";

/** Legacy agent media payload layout consumed by older agent adapters. */
export type AgentMediaPayload = Omit<MediaFactLegacyProjection, "MediaTranscribedIndexes">;

export function buildAgentMediaPayload(
  mediaList: Array<{ path: string; contentType?: string | null }>,
): AgentMediaPayload {
  return projectMediaFacts(mediaList, "compact");
}
