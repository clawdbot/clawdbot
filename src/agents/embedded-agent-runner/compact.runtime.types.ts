import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type CompactEmbeddedAgentSessionDirect = (
  params: CompactEmbeddedAgentSessionParams,
) => Promise<EmbeddedAgentCompactResult>;
