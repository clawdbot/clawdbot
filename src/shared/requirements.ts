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

function normalizeOsRequirementPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return normalized === "macos" ? "darwin" : normalized;
}

/** Evaluates entry requirements against the current host and optional remote capabilities. */
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
  const required: Requirements = {
    bins: params.metadata?.requires?.bins ?? [],
    anyBins: params.metadata?.requires?.anyBins ?? [],
    env: params.metadata?.requires?.env ?? [],
    config: params.metadata?.requires?.config ?? [],
    os: params.metadata?.os ?? [],
  };

  const hasRemoteBin = params.remote?.hasBin;
  const hasRemoteAnyBin = params.remote?.hasAnyBin;
  const missingBins = required.bins.filter(
    (bin) => !params.hasLocalBin(bin) && !hasRemoteBin?.(bin),
  );
  const missingAnyBins =
    required.anyBins.length === 0 ||
    required.anyBins.some((bin) => params.hasLocalBin(bin)) ||
    hasRemoteAnyBin?.(required.anyBins)
      ? []
      : required.anyBins;

  let missingOs: string[] = [];
  if (required.os.length > 0) {
    const localPlatform = normalizeOsRequirementPlatform(params.localPlatform);
    const requiredPlatforms = new Set(required.os.map(normalizeOsRequirementPlatform));
    if (
      !requiredPlatforms.has(localPlatform) &&
      !params.remote?.platforms?.some((platform) =>
        requiredPlatforms.has(normalizeOsRequirementPlatform(platform)),
      )
    ) {
      missingOs = required.os;
    }
  }

  const missingEnv = required.env.filter((envName) => !params.isEnvSatisfied(envName));
  const configChecks = required.config.map((path) => ({
    path,
    satisfied: params.isConfigSatisfied(path),
  }));
  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  // `always` bypasses runtime requirements, but OS remains a hard compatibility boundary.
  const missing = {
    bins: params.always ? [] : missingBins,
    anyBins: params.always ? [] : missingAnyBins,
    env: params.always ? [] : missingEnv,
    config: params.always ? [] : missingConfig,
    os: missingOs,
  };

  const eligible =
    missing.os.length === 0 &&
    (params.always ||
      (missing.bins.length === 0 &&
        missing.anyBins.length === 0 &&
        missing.env.length === 0 &&
        missing.config.length === 0));

  return { required, missing, eligible, configChecks };
}
