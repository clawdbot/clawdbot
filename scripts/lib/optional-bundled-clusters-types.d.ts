export const optionalBundledClusters: string[];
export const optionalBundledClusterSet: Set<string>;
export const OPTIONAL_BUNDLED_BUILD_ENV: "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";
export function isOptionalBundledCluster(cluster: string): boolean;
export function shouldIncludeOptionalBundledClusters(env?: NodeJS.ProcessEnv): boolean;
export function hasReleasedBundledInstall(packageJson: unknown): boolean;
export function shouldBuildBundledCluster(
  cluster: string,
  env?: NodeJS.ProcessEnv,
  options?: { packageJson?: unknown },
): boolean;
