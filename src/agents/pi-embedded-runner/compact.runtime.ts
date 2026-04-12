import type { CompactEmbeddedPiSessionDirect } from "./compact.runtime.types.js";

let compactRuntimePromise: Promise<typeof import("./compact.js")> | null = null;

function loadCompactRuntime() {
  compactRuntimePromise ??= import("./compact.js");
  return compactRuntimePromise;
}

export async function compactEmbeddedPiSessionDirect(
  ...args: Parameters<CompactEmbeddedPiSessionDirect>
): ReturnType<CompactEmbeddedPiSessionDirect> {
  const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
  return compactEmbeddedPiSessionDirect(...args);
}
