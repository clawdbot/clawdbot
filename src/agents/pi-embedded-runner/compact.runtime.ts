import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedPiSessionDirect } from "./compact.runtime.types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

function loadCompactRuntime() {
  return compactRuntimeLoader.load();
}

export async function compactEmbeddedPiSessionDirect(
  ...args: Parameters<CompactEmbeddedPiSessionDirect>
): ReturnType<CompactEmbeddedPiSessionDirect> {
  const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
  return compactEmbeddedPiSessionDirect(...args);
}
