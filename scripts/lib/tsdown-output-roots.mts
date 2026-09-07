// Lists package dist roots produced by tsdown builds.
const TSDOWN_PACKAGE_NAMES = [
  "agent-core",
  "ai",
  "gateway-client",
  "gateway-protocol",
  "llm-core",
  "markdown-core",
  "media-core",
  "media-generation-core",
  "media-understanding-common",
  "model-catalog-core",
  "net-policy",
  "normalization-core",
  "retry",
  "terminal-core",
  "acp-core",
] as const;

/**
 * Dist roots for all packages built through the shared tsdown pipeline.
 */
export const TSDOWN_PACKAGE_OUTPUT_ROOTS = TSDOWN_PACKAGE_NAMES.map(packageOutputRoot);

/**
 * Returns the dist root for a known tsdown package name.
 */
export function tsdownPackageOutputRoot(packageName: string): string {
  if (!TSDOWN_PACKAGE_NAMES.some((candidate) => candidate === packageName)) {
    throw new Error(`Unknown tsdown package output root: ${packageName}`);
  }
  return packageOutputRoot(packageName);
}

function packageOutputRoot(packageName: string): string {
  return `packages/${packageName}/dist`;
}
