type PluginSdkAliasMap = Record<string, string>;

export type PluginSdkPackageJson = {
  name?: string;
  exports?: Record<string, unknown>;
  bin?: string | Record<string, unknown>;
  version?: string;
};

export type WorkspacePackageAliasEntry = {
  packageName: string;
  packageDir: string;
  subpath: string;
  srcFile: string;
  distFile: string;
};

export type PluginRuntimeModuleResolution = {
  modulePath?: string;
  packageRoot: string | null;
  candidates: string[];
  resolvedPath: string | null;
  error?: string;
};

export type BundledPackageCacheIdentity = {
  packageJson: string;
  packageRoot: string;
  packageVersion: string;
  size: number;
  mtimeMs: number;
};

type PluginLoaderModuleConfig = {
  tryNative: boolean;
  aliasMap: PluginSdkAliasMap;
  cacheKey: string;
};

type PluginSdkHostFacts = {
  packageJson?: PluginSdkPackageJson | null;
  nativePackage?: { name?: string; hasOpenClawBin: boolean } | null;
  trustedRoot?: boolean;
  exportedSubpaths?: string[] | null;
  privateSubpaths?: string[];
  workspaceExports: Map<string, WorkspacePackageAliasEntry[]>;
  subpathsByOwner: Map<string, string[]>;
  aliasesByOwner: Map<string, PluginSdkAliasMap>;
  bundledAliasesByMode: Map<string, PluginSdkAliasMap>;
  workspaceAliasesByMode: Map<string, PluginSdkAliasMap>;
};

function createPluginSdkHostFacts(): PluginSdkHostFacts {
  return {
    workspaceExports: new Map(),
    subpathsByOwner: new Map(),
    aliasesByOwner: new Map(),
    bundledAliasesByMode: new Map(),
    workspaceAliasesByMode: new Map(),
  };
}

/** Derived SDK facts share the plugin cache lifetime; none owns a separate expiry. */
export function createPluginCacheSdk() {
  return {
    hosts: new Map<string, PluginSdkHostFacts>(),
    contexts: new Map<
      string,
      {
        aliasMap?: PluginSdkAliasMap;
        moduleConfig?: PluginLoaderModuleConfig;
      }
    >(),
    packageNames: new Map<string, string | null>(),
    packageSearches: new Map<string, { first?: string | null; all?: string[] }>(),
    argvDirectories: new Map<string, string[]>(),
    devSourceRoots: new Map<string, string | null>(),
    bundledPackages: new Map<string, BundledPackageCacheIdentity | undefined>(),
    runtimeModules: new Map<string, PluginRuntimeModuleResolution>(),
    usableDistArtifacts: new Map<string, boolean>(),
    normalizedJitiAliases: new Map<string, PluginSdkAliasMap>(),
    aliasFacts: new WeakMap<
      PluginSdkAliasMap,
      {
        normalizedJiti?: PluginSdkAliasMap;
        normalizedTargets?: PluginSdkAliasMap;
        moduleKey?: string;
      }
    >(),
    mergedAliases: new WeakMap<
      PluginSdkAliasMap,
      WeakMap<PluginSdkAliasMap, WeakMap<PluginSdkAliasMap, PluginSdkAliasMap>>
    >(),
    native: {
      aliases: new Map<string, Array<{ parentRoot: string; target: string }>>(),
      aliasesByMap: new WeakMap<PluginSdkAliasMap, Array<readonly [string, string]>>(),
      registeredHosts: new Set<string>(),
      hostRoots: new Map<string, string>(),
      nearestPackageRoots: new Map<string, string>(),
      loaderPackageRoots: new Map<string, string>(),
      allowedParentRoots: new Map<string, string>(),
    },
  };
}

export type PluginCacheSdk = ReturnType<typeof createPluginCacheSdk>;

export function getPluginSdkHostFacts(
  cache: PluginCacheSdk,
  packageRoot: string,
): PluginSdkHostFacts {
  let facts = cache.hosts.get(packageRoot);
  if (!facts) {
    facts = createPluginSdkHostFacts();
    cache.hosts.set(packageRoot, facts);
  }
  return facts;
}
