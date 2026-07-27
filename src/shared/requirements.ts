// Requirement types describe runtime requirements advertised by shared surfaces.
export type Requirements = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type RequirementConfigCheck = {
  path: string;
  satisfied: boolean;
};

export type RequirementsMetadata = {
  requires?: Partial<Pick<Requirements, "bins" | "anyBins" | "env" | "config">>;
  os?: string[];
};

export type RequirementRemote = {
  hasBin?: (bin: string) => boolean;
  hasAnyBin?: (bins: string[]) => boolean;
  platforms?: string[];
};

type RequirementsEvaluationContext = {
  always: boolean;
  hasLocalBin: (bin: string) => boolean;
  localPlatform: string;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
};

type RequirementsEvaluationRemoteContext = {
  hasRemoteBin?: (bin: string) => boolean;
  hasRemoteAnyBin?: (bins: string[]) => boolean;
  remotePlatforms?: string[];
};

/** Returns required binaries absent from both the local host and optional remote target. */
function resolveMissingBins(params: {
  required: string[];
  hasLocalBin: (bin: string) => boolean;
  hasRemoteBin?: (bin: string) => boolean;
}): string[] {
  const remote = params.hasRemoteBin;
  return params.required.filter((bin) => {
    if (params.hasLocalBin(bin)) {
      return false;
    }
    if (remote?.(bin)) {
      return false;
    }
    return true;
  });
}

/** Treats an any-bin requirement as satisfied when any listed binary exists locally or remotely. */
function resolveMissingAnyBins(params: {
  required: string[];
  hasLocalBin: (bin: string) => boolean;
  hasRemoteAnyBin?: (bins: string[]) => boolean;
}): string[] {
  if (params.required.length === 0) {
    return [];
  }
  if (params.required.some((bin) => params.hasLocalBin(bin))) {
    return [];
  }
  if (params.hasRemoteAnyBin?.(params.required)) {
    return [];
  }
  return params.required;
}

/** Resolves OS requirements against local and remote platforms, accepting macos as darwin. */
function resolveMissingOs(params: {
  required: string[];
  localPlatform: string;
  remotePlatforms?: string[];
}): string[] {
  if (params.required.length === 0) {
    return [];
  }
  const localPlatform = normalizeOsRequirementPlatform(params.localPlatform);
  const requiredPlatforms = new Set(
    params.required.map((platform) => normalizeOsRequirementPlatform(platform)),
  );
  if (requiredPlatforms.has(localPlatform)) {
    return [];
  }
  if (
    params.remotePlatforms?.some((platform) =>
      requiredPlatforms.has(normalizeOsRequirementPlatform(platform)),
    )
  ) {
    return [];
  }
  return params.required;
}

function normalizeOsRequirementPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return normalized === "macos" ? "darwin" : normalized;
}

/** Returns environment variable names whose caller-provided satisfaction check fails. */
function resolveMissingEnv(params: {
  required: string[];
  isSatisfied: (envName: string) => boolean;
}): string[] {
  const missing: string[] = [];
  for (const envName of params.required) {
    if (params.isSatisfied(envName)) {
      continue;
    }
    missing.push(envName);
  }
  return missing;
}

/** Builds per-config-path status while preserving every declared path for UI diagnostics. */
function buildConfigChecks(params: {
  required: string[];
  isSatisfied: (pathStr: string) => boolean;
}): RequirementConfigCheck[] {
  return params.required.map((pathStr) => {
    const satisfied = params.isSatisfied(pathStr);
    return { path: pathStr, satisfied };
  });
}

/** Evaluates normalized requirements and returns missing categories plus config diagnostics. */
function evaluateRequirements(
  params: RequirementsEvaluationContext &
    RequirementsEvaluationRemoteContext & {
      required: Requirements;
    },
): { missing: Requirements; eligible: boolean; configChecks: RequirementConfigCheck[] } {
  const missingBins = resolveMissingBins({
    required: params.required.bins,
    hasLocalBin: params.hasLocalBin,
    hasRemoteBin: params.hasRemoteBin,
  });
  const missingAnyBins = resolveMissingAnyBins({
    required: params.required.anyBins,
    hasLocalBin: params.hasLocalBin,
    hasRemoteAnyBin: params.hasRemoteAnyBin,
  });
  const missingOs = resolveMissingOs({
    required: params.required.os,
    localPlatform: params.localPlatform,
    remotePlatforms: params.remotePlatforms,
  });
  const missingEnv = resolveMissingEnv({
    required: params.required.env,
    isSatisfied: params.isEnvSatisfied,
  });
  const configChecks = buildConfigChecks({
    required: params.required.config,
    isSatisfied: params.isConfigSatisfied,
  });
  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  // `always` keeps diagnostics visible while making runtime eligibility unconditional.
  const missing = params.always
    ? { bins: [], anyBins: [], env: [], config: [], os: [] }
    : {
        bins: missingBins,
        anyBins: missingAnyBins,
        env: missingEnv,
        config: missingConfig,
        os: missingOs,
      };

  const eligible =
    params.always ||
    (missing.bins.length === 0 &&
      missing.anyBins.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0 &&
      missing.os.length === 0);

  return { missing, eligible, configChecks };
}

/** Converts entry metadata into the canonical requirement shape before evaluation. */
function evaluateRequirementsFromMetadata(
  params: RequirementsEvaluationContext &
    RequirementsEvaluationRemoteContext & {
      metadata?: RequirementsMetadata;
    },
): {
  required: Requirements;
  missing: Requirements;
  eligible: boolean;
  configChecks: RequirementConfigCheck[];
} {
  const required: Requirements = {
    bins: params.metadata?.requires?.bins ?? [],
    anyBins: params.metadata?.requires?.anyBins ?? [],
    env: params.metadata?.requires?.env ?? [],
    config: params.metadata?.requires?.config ?? [],
    os: params.metadata?.os ?? [],
  };

  const result = evaluateRequirements({
    always: params.always,
    required,
    hasLocalBin: params.hasLocalBin,
    hasRemoteBin: params.hasRemoteBin,
    hasRemoteAnyBin: params.hasRemoteAnyBin,
    localPlatform: params.localPlatform,
    remotePlatforms: params.remotePlatforms,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
  return { required, ...result };
}

/** Convenience wrapper for callers that receive remote capability checks as one object. */
export function evaluateRequirementsFromMetadataWithRemote(
  params: RequirementsEvaluationContext & {
    metadata?: RequirementsMetadata;
    remote?: RequirementRemote;
  },
): {
  required: Requirements;
  missing: Requirements;
  eligible: boolean;
  configChecks: RequirementConfigCheck[];
} {
  return evaluateRequirementsFromMetadata({
    always: params.always,
    metadata: params.metadata,
    hasLocalBin: params.hasLocalBin,
    hasRemoteBin: params.remote?.hasBin,
    hasRemoteAnyBin: params.remote?.hasAnyBin,
    localPlatform: params.localPlatform,
    remotePlatforms: params.remote?.platforms,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
}
