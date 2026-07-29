/** Build fully qualified deprecated plugin SDK module specifiers from subpath metadata. */
export function buildDeprecatedPluginSdkModuleSpecifiers(deprecatedSubpaths?: string[]): string[];

/** Deprecated facade module banned for internal importers outside its compat re-export chain. */
export type BannedInternalPluginSdkFacadeModule = {
  /** Extension-less repo path of the banned facade module. */
  modulePath: string;
  /** Canonical plugin SDK subpath internal callers should import instead. */
  canonical: string;
  /** Repo paths of the compat re-export chain allowed to import the facade. */
  allowedImporters?: string[];
};

/** Table of deprecated facade modules with zero allowed internal importers. */
export const BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES: BannedInternalPluginSdkFacadeModule[];
