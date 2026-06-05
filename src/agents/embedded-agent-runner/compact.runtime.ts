/**
 * Lazy-loads the embedded-agent compaction runtime.
 */
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedAgentSessionDirect } from "./compact.runtime.types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

function loadCompactRuntime() {
  return compactRuntimeLoader.load();
}

/** Loads the compaction runtime on demand and forwards the direct compaction call. */
export async function compactEmbeddedAgentSessionDirect(
  ...args: Parameters<CompactEmbeddedAgentSessionDirect>
): ReturnType<CompactEmbeddedAgentSessionDirect> {
  const { compactEmbeddedAgentSessionDirect: compactEmbeddedAgentSessionDirectLocal } =
    await loadCompactRuntime();
  return compactEmbeddedAgentSessionDirectLocal(...args);
}
