const TSDOWN_PACKAGE_NAMES = [
  "agent-core",
  "gateway-client",
  "gateway-protocol",
  "llm-core",
  "llm-runtime",
  "markdown-core",
  "media-generation-core",
  "media-understanding-common",
  "model-catalog-core",
  "net-policy",
  "normalization-core",
  "speech-core",
  "terminal-core",
];

export const TSDOWN_PACKAGE_OUTPUT_ROOTS = TSDOWN_PACKAGE_NAMES.map(packageOutputRoot);

export function tsdownPackageOutputRoot(packageName) {
  if (!TSDOWN_PACKAGE_NAMES.includes(packageName)) {
    throw new Error(`Unknown tsdown package output root: ${packageName}`);
  }
  return packageOutputRoot(packageName);
}

function packageOutputRoot(packageName) {
  return `packages/${packageName}/dist`;
}
