/**
 * Lazy-loads the embedded-agent compaction runtime.
 */
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

function loadCompactRuntime() {
  return compactRuntimeLoader.load();
}

/** Loads the compaction runtime on demand and forwards the direct compaction call. */
export async function compactEmbeddedAgentSessionOnDemand(
  params: CompactEmbeddedAgentSessionRuntimeParams,
): Promise<EmbeddedAgentCompactResult> {
  const { compactEmbeddedAgentSessionDirect } = await loadCompactRuntime();
  return compactEmbeddedAgentSessionDirect(params);
}
