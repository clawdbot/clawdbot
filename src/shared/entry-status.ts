import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  evaluateRequirementsFromMetadataWithRemote,
  type RequirementConfigCheck,
  type RequirementRemote,
  type Requirements,
  type RequirementsMetadata,
} from "./requirements.js";

/** Evaluates skill and hook presentation metadata and requirements on the current platform. */
export function evaluateEntryRequirementsForCurrentPlatform(params: {
  always: boolean;
  entry: {
    metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
    frontmatter?: {
      emoji?: string;
      homepage?: string;
      website?: string;
      url?: string;
    } | null;
  };
  hasLocalBin: (bin: string) => boolean;
  remote?: RequirementRemote;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}): {
  emoji?: string;
  homepage?: string;
  required: Requirements;
  missing: Requirements;
  requirementsSatisfied: boolean;
  configChecks: RequirementConfigCheck[];
} {
  const { metadata, frontmatter } = params.entry;
  const emoji = metadata?.emoji ?? frontmatter?.emoji;
  // Explicit blank values suppress lower-priority aliases; normalize only after selection.
  const homepage = normalizeOptionalString(
    metadata?.homepage ?? frontmatter?.homepage ?? frontmatter?.website ?? frontmatter?.url,
  );
  const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
    always: params.always,
    metadata: metadata ?? undefined,
    hasLocalBin: params.hasLocalBin,
    localPlatform: process.platform,
    remote: params.remote,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
  return {
    ...(emoji ? { emoji } : {}),
    ...(homepage ? { homepage } : {}),
    required,
    missing,
    requirementsSatisfied: eligible,
    configChecks,
  };
}
