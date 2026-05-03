const optionalBundledClusters = [
  "acpx",
  "diagnostics-otel",
  "diffs",
  "googlechat",
  "memory-lancedb",
  "msteams",
  "nostr",
  "tlon",
  "twitch",
  "ui",
  "whatsapp",
  "zalouser",
];

export const optionalBundledClusterSet = new Set(optionalBundledClusters);

const OPTIONAL_BUNDLED_BUILD_ENV = "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";

function isOptionalBundledCluster(cluster) {
  return optionalBundledClusterSet.has(cluster);
}

function shouldIncludeOptionalBundledClusters(env = process.env) {
  // Release artifacts should preserve the last shipped upgrade surface by
  // default. Specific size-sensitive lanes can still opt out explicitly.
  return env[OPTIONAL_BUNDLED_BUILD_ENV] !== "0";
}

function hasReleasedBundledInstall(packageJson) {
  return (
    typeof packageJson?.openclaw?.install?.npmSpec === "string" &&
    packageJson.openclaw.install.npmSpec.trim().length > 0
  );
}

export function shouldBuildBundledCluster(cluster, env = process.env, options = {}) {
  if (hasReleasedBundledInstall(options.packageJson)) {
    return true;
  }
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}
