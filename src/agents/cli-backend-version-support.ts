/** Shared version guidance for provider-owned CLI backend protocol requirements. */
import { coerce as coerceSemver } from "semver";
import { compareValidSemver } from "../infra/semver.js";
import type { CliBackendLiveSessionRequirement } from "../plugins/cli-backend.types.js";

type CliBackendVersionGuidance =
  | { status: "at-or-above-known-floor"; version: string }
  | { status: "below-known-floor"; version: string }
  | { status: "unknown" };

/** Compare human CLI version output with the provider's first-known compatible release. */
export function resolveCliBackendVersionGuidance(
  versionOutput: string | undefined,
  requirement: CliBackendLiveSessionRequirement,
): CliBackendVersionGuidance {
  const parsed = versionOutput ? coerceSemver(versionOutput)?.version : undefined;
  if (!parsed) {
    return { status: "unknown" };
  }
  const comparison = compareValidSemver(parsed, requirement.minimumVersion);
  if (comparison === null) {
    return { status: "unknown" };
  }
  return {
    status: comparison < 0 ? "below-known-floor" : "at-or-above-known-floor",
    version: parsed,
  };
}

/** Advisory guidance; runtime capability negotiation remains authoritative. */
export function formatCliBackendVersionAdvisory(params: {
  label: string;
  requirement: CliBackendLiveSessionRequirement;
  version: string;
}): string {
  return `${params.label} ${params.requirement.minimumVersion} is the first published build known to advertise ${params.requirement.capability}; found ${params.version}. OpenClaw verifies this capability at runtime. If this build is rejected, run \`${params.requirement.updateCommand}\`, restart OpenClaw, and retry.`;
}
