import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Registers source-tree TypeScript resolution inside a Worker on supported Node versions. */
export function resolveRuntimeWorkerExecArgv(url: URL): string[] | undefined {
  if (!url.pathname.endsWith(".ts")) {
    return undefined;
  }
  // Node 22 can strip the entrypoint, but `--import tsx` does not install tsx's
  // ESM resolver inside a Worker. Use the supported programmatic registration API.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

export function resolveRuntimeWorkerArgv(url: URL): string[] {
  return url.pathname.endsWith(".ts")
    ? ["--import", "tsx", fileURLToPath(url)]
    : [fileURLToPath(url)];
}
