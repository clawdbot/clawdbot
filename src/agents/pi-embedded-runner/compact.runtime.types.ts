import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import type { EmbeddedPiCompactResult } from "./types.js";

export type CompactEmbeddedPiSessionDirect = (
  params: CompactEmbeddedPiSessionParams,
) => Promise<EmbeddedPiCompactResult>;
