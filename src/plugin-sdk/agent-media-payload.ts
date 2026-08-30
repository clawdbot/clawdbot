import { projectMediaFacts, type MediaFactLegacyProjection } from "../media/media-facts.js";

/** @deprecated Import from `openclaw/plugin-sdk/media-local-roots`. */
export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";

/**
 * Legacy agent media payload layout consumed by older agent adapters.
 * @deprecated Pass ordered facts as `MsgContext.media`; use
 * `toInboundMediaFacts` from `openclaw/plugin-sdk/channel-inbound`.
 */
export type AgentMediaPayload = Omit<MediaFactLegacyProjection, "MediaTranscribedIndexes">;

/**
 * @deprecated Pass ordered facts as `MsgContext.media`; use
 * `toInboundMediaFacts` from `openclaw/plugin-sdk/channel-inbound`.
 */
export function buildAgentMediaPayload(
  mediaList: Array<{ path: string; contentType?: string | null }>,
): AgentMediaPayload {
  return projectMediaFacts(mediaList, "compact");
}
