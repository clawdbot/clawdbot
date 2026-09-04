import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBunRuntime } from "../daemon/runtime-binary.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

/** Resolve a source worker sibling or its stable packaged path under dist. */
export function resolveRuntimeWorkerUrl(params: {
  currentModuleUrl: string;
  sourceWorkerName: string;
  distWorkerPath: string;
}): URL {
  const currentPath = fileURLToPath(params.currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, params.distWorkerPath));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./${params.sourceWorkerName}${extension}`, params.currentModuleUrl);
}

export function resolveRuntimeWorkerArgv(url: URL, execPath = process.execPath): string[] {
  const entry = fileURLToPath(url);
  return /\.[cm]?ts$/.test(entry) && !isBunRuntime(execPath) ? ["--import", "tsx", entry] : [entry];
}

type RuntimeProcessEntrypointName = keyof typeof runtimeProcessEntrypoints;

const sealedEntrypoints = new Map<RuntimeProcessEntrypointName, URL>();

// Sealed deploy bundles ship an entrypoint beside their own module without a /dist/
// marker; the bundle registers that sibling before any launch resolves it.
export function registerSealedRuntimeProcessEntrypoint(
  name: RuntimeProcessEntrypointName,
  url: URL,
): void {
  sealedEntrypoints.set(name, url);
}

export function resolveRuntimeProcessEntrypointUrl(name: RuntimeProcessEntrypointName): URL {
  return sealedEntrypoints.get(name) ?? resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]);
}
