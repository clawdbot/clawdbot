function createEmptyRequirements() {
  return {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
    os: [],
  };
}

export function createEmptyInstallChecks() {
  return {
    requirements: createEmptyRequirements(),
    missing: createEmptyRequirements(),
    configChecks: [],
    install: [],
  };
}
