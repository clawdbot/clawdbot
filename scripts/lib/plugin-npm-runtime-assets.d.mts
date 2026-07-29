/** Run a package-local static asset build command when the plugin declares one. */
export function runPackageAssetBuild(plan: unknown): string | null;
/** List static asset source paths referenced by a package but missing from disk. */
export function listMissingPackageStaticAssetSources(plan: unknown): string[];
