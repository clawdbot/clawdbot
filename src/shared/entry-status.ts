// Entry status helpers resolve display metadata for run and queue entries.
import { resolveEmojiAndHomepage } from "./entry-metadata.js";
import {
  evaluateRequirementsFromMetadataWithRemote,
  type RequirementConfigCheck,
  type RequirementRemote,
  type Requirements,
  type RequirementsMetadata,
} from "./requirements.js";

type EntryMetadataRequirementsParams = Parameters<typeof evaluateEntryMetadataRequirements>[0];

/** Resolves entry presentation metadata and requirement eligibility in one shared shape. */
export function evaluateEntryMetadataRequirements(params: {
  always: boolean;
  metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
  frontmatter?: {
    emoji?: string;
    homepage?: string;
    website?: string;
    url?: string;
  } | null;
  hasLocalBin: (bin: string) => boolean;
  localPlatform: string;
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
  const { emoji, homepage } = resolveEmojiAndHomepage({
    metadata: params.metadata,
    frontmatter: params.frontmatter,
  });
  const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
    always: params.always,
    metadata: params.metadata ?? undefined,
    hasLocalBin: params.hasLocalBin,
    localPlatform: params.localPlatform,
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

/** Evaluates entry metadata requirements against the current Node platform. */
export function evaluateEntryMetadataRequirementsForCurrentPlatform(
  params: Omit<EntryMetadataRequirementsParams, "localPlatform">,
): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirements({
    ...params,
    localPlatform: process.platform,
  });
}

/** Evaluates an entry object's metadata/frontmatter requirements on the current platform. */
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
}): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirementsForCurrentPlatform({
    always: params.always,
    metadata: params.entry.metadata,
    frontmatter: params.entry.frontmatter,
    hasLocalBin: params.hasLocalBin,
    remote: params.remote,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
}
