import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

type RuntimeProcessEntrypointName = keyof typeof runtimeProcessEntrypoints;

const sealedEntrypoints = new Map<RuntimeProcessEntrypointName, URL>();

// Deploy bundles register their sibling before launch: their paths have no /dist/ marker.
export function registerSealedRuntimeProcessEntrypoint(
  name: RuntimeProcessEntrypointName,
  url: URL,
): void {
  sealedEntrypoints.set(name, url);
}

export function resolveRuntimeProcessEntrypointUrl(name: RuntimeProcessEntrypointName): URL {
  return sealedEntrypoints.get(name) ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]);
}
