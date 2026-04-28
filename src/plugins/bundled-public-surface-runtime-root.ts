import path from "node:path";
import {
  isBuiltBundledPluginRuntimeRoot,
  prepareBundledPluginRuntimeRoot,
} from "./bundled-runtime-root.js";

export type BundledPublicSurfaceLocation = {
  modulePath: string;
  boundaryRoot: string;
};

export function resolveBuiltBundledPluginRootFromModulePath(params: {
  modulePath: string;
  pluginId: string;
}): string | null {
  const resolvedModulePath = path.resolve(params.modulePath);
  let currentDir = path.dirname(resolvedModulePath);
  while (true) {
    if (
      path.basename(currentDir) === params.pluginId &&
      isBuiltBundledPluginRuntimeRoot(currentDir)
    ) {
      const relativePath = path.relative(currentDir, resolvedModulePath);
      if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        return currentDir;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function prepareBuiltBundledPluginPublicSurfaceLocation(params: {
  location: BundledPublicSurfaceLocation;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): BundledPublicSurfaceLocation {
  const pluginRoot = resolveBuiltBundledPluginRootFromModulePath({
    modulePath: params.location.modulePath,
    pluginId: params.pluginId,
  });
  if (!pluginRoot) {
    return params.location;
  }
  const prepared = prepareBundledPluginRuntimeRoot({
    pluginId: params.pluginId,
    pluginRoot,
    modulePath: params.location.modulePath,
    ...(params.env ? { env: params.env } : {}),
  });
  return {
    modulePath: prepared.modulePath,
    boundaryRoot: prepared.pluginRoot,
  };
}
