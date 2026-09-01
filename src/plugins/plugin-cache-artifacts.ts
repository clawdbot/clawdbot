/** Immutable artifact facts acquired by one plugin cache generation. */
type PluginArtifactLocation = { modulePath: string; boundaryRoot: string };

type PluginModuleCacheVariant = {
  exports?: { value: unknown };
  pending?: Promise<unknown>;
};

export type PluginSourceCacheRecord = {
  modulePath?: string;
  variants: Map<string, PluginModuleCacheVariant>;
  validatedBoundaries: Set<string>;
  boundaryRoot?: string;
  facadeTracked?: true;
  publicSurface?: { exports?: object; pending?: Promise<object> };
};

type PluginPublicSurfaceBoundary = { boundaryLabel: string; rejectHardlinks: boolean };

type PluginRootArtifactCache = {
  publicSurfaceBoundary?: PluginPublicSurfaceBoundary;
  artifactLoadsInProgress: Set<string>;
  artifacts: Map<string, PluginArtifactLocation | null>;
  runtimeArtifacts: Map<string, { source: string; rootDir: string }>;
  entryBoundaries: Map<
    string,
    {
      importerPath: string;
      importerDir: string;
      boundaryRoot: string;
      packageRoot: string | null;
    }
  >;
  entryPaths: Map<string, { path: string } | { error: Error }>;
};

export function createPluginCacheArtifacts(): {
  moduleLoaders: Map<string, (target: string) => unknown>;
  sources: Map<string, PluginSourceCacheRecord>;
  sourceAliases: Map<string, string>;
  disposeModules?: () => void;
} {
  return { moduleLoaders: new Map(), sources: new Map(), sourceAliases: new Map() };
}

export function createPluginRootArtifacts(): PluginRootArtifactCache {
  return {
    artifactLoadsInProgress: new Set<string>(),
    artifacts: new Map<string, PluginArtifactLocation | null>(),
    runtimeArtifacts: new Map<string, { source: string; rootDir: string }>(),
    entryBoundaries: new Map<
      string,
      {
        importerPath: string;
        importerDir: string;
        boundaryRoot: string;
        packageRoot: string | null;
      }
    >(),
    entryPaths: new Map<string, { path: string } | { error: Error }>(),
  };
}
