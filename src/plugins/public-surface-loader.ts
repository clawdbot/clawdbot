// Loads documented plugin public surfaces while preserving lazy boundaries.
import {
  MissingPublicSurfaceError,
  loadFacadeModuleAtLocationSync,
  resolveBundledPublicSurfaceLocation,
} from "../plugin-sdk/facade-loader.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { resolvePluginRootPublicSurfacePath } from "./public-surface-runtime.js";

function loadValidatedPublicSurfaceModule(params: {
  modulePath: string;
  boundaryRoot: string;
  surfaceLabel: string;
  origin: "bundled" | "global";
  pluginId?: string;
}): object {
  return loadFacadeModuleAtLocationSync({
    location: params,
    surfaceLabel: params.surfaceLabel,
    pluginId: params.pluginId,
    boundary: {
      boundaryLabel: "plugin root",
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: params.origin,
        rootDir: params.boundaryRoot,
      }),
    },
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T {
  const loaded = loadBundledPluginPublicArtifactModuleFromCandidatesSync<T>({
    ...params,
    artifactCandidates: [params.artifactBasename],
  });
  if (!loaded) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loaded;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadPluginPublicArtifactModuleSync<T extends object>(params: {
  pluginRoot: string;
  artifactBasename: string;
  origin?: "bundled" | "global";
  pluginId?: string;
}): T {
  const modulePath = resolvePluginRootPublicSurfacePath(params);
  const location = modulePath ? { modulePath, boundaryRoot: params.pluginRoot } : null;
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve plugin public surface ${params.pluginRoot}/${params.artifactBasename}`,
    );
  }
  return loadValidatedPublicSurfaceModule({
    ...location,
    surfaceLabel: `plugin public surface ${params.artifactBasename}`,
    origin: params.origin ?? "global",
    pluginId: params.pluginId,
  }) as T;
}

/** Loads the first resolvable bundled public artifact from an ordered candidate list. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleFromCandidatesSync<T extends object>(params: {
  dirName: string;
  artifactCandidates: readonly string[];
  env?: NodeJS.ProcessEnv;
}): T | null {
  for (const artifactBasename of params.artifactCandidates) {
    const location = resolveBundledPublicSurfaceLocation({
      dirName: params.dirName,
      artifactBasename,
      env: params.env,
      preferSource: false,
    });
    if (location) {
      return loadValidatedPublicSurfaceModule({
        ...location,
        surfaceLabel: `bundled plugin public surface ${params.dirName}/${artifactBasename}`,
        origin: "bundled",
      }) as T;
    }
  }
  return null;
}
