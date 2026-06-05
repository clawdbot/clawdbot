/**
 * Types for the lazy embedded-agent compaction runtime boundary.
 */
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

/**
 * Lazy-runtime signature for direct embedded session compaction.
 */
export type CompactEmbeddedAgentSessionDirect = (
  params: CompactEmbeddedAgentSessionParams,
) => Promise<EmbeddedAgentCompactResult>;
