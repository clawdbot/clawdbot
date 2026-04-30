import fs from "node:fs";
import path from "node:path";

const preparedBundledRuntimeDistMirrors = new Set<string>();

export function clearBundledRuntimeDistMirrorPreparationCache(): void {
  preparedBundledRuntimeDistMirrors.clear();
}

export function shouldReusePreparedBundledRuntimeDistMirror(params: {
  sourceDistRoot: string;
  mirrorDistRoot: string;
}): boolean {
  if (isSourceCheckoutDistRoot(params.sourceDistRoot)) {
    return false;
  }
  if (!preparedBundledRuntimeDistMirrors.has(bundledRuntimeDistMirrorCacheKey(params))) {
    return false;
  }
  return (
    fs.existsSync(params.mirrorDistRoot) &&
    fs.existsSync(path.join(params.mirrorDistRoot, "extensions")) &&
    fs.existsSync(path.join(params.mirrorDistRoot, "package.json"))
  );
}

export function markBundledRuntimeDistMirrorPrepared(params: {
  sourceDistRoot: string;
  mirrorDistRoot: string;
}): void {
  if (isSourceCheckoutDistRoot(params.sourceDistRoot)) {
    return;
  }
  preparedBundledRuntimeDistMirrors.add(bundledRuntimeDistMirrorCacheKey(params));
}

function bundledRuntimeDistMirrorCacheKey(params: {
  sourceDistRoot: string;
  mirrorDistRoot: string;
}): string {
  return `${path.resolve(params.sourceDistRoot)}\0${path.resolve(params.mirrorDistRoot)}`;
}

function isSourceCheckoutDistRoot(sourceDistRoot: string): boolean {
  const packageRoot = path.dirname(sourceDistRoot);
  return (
    (fs.existsSync(path.join(packageRoot, ".git")) ||
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml"))) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}
