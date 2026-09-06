import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBunRuntime } from "../daemon/runtime-binary.js";

const requireFromHere = createRequire(import.meta.url);

/** Resolve an explicit installed root, source sibling, or stable packaged worker path. */
export function resolveRuntimeWorkerUrl(params: {
  currentModuleUrl: string;
  sourceWorkerName: string;
  distWorkerPath: string;
  root?: string;
}): URL {
  if (params.root !== undefined) {
    return pathToFileURL(path.join(params.root, "dist", params.distWorkerPath));
  }
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
  if (/\.[cm]?ts$/.test(entry) && !isBunRuntime(execPath)) {
    // Pin the tsx loader to an absolute file:// URL so worker spawns resolve
    // the package from the OpenClaw root, not the child process cwd. A bare
    // "tsx" specifier fails with ERR_MODULE_NOT_FOUND when the worker's cwd
    // is outside a package root containing tsx. (#140416)
    const tsxUrl = pathToFileURL(requireFromHere.resolve("tsx")).href;
    return ["--import", tsxUrl, entry];
  }
  return [entry];
}
