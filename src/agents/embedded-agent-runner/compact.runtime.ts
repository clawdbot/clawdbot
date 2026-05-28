import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedAgentSessionDirect } from "./compact.runtime.types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

function loadCompactRuntime() {
  return compactRuntimeLoader.load();
}

export async function compactEmbeddedAgentSessionDirect(
  ...args: Parameters<CompactEmbeddedAgentSessionDirect>
): ReturnType<CompactEmbeddedAgentSessionDirect> {
  const { compactEmbeddedAgentSessionDirect } = await loadCompactRuntime();
  return compactEmbeddedAgentSessionDirect(...args);
}
