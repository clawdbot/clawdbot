// Shared empty requirement/install-check fixtures for CLI tests.
function createEmptyRequirements() {
  return {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
    os: [],
  };
}

/** Build an empty install-check result with all requirement buckets present. */
export function createEmptyInstallChecks() {
  return {
    requirements: createEmptyRequirements(),
    missing: createEmptyRequirements(),
    configChecks: [],
    install: [],
  };
}
