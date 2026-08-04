/** Shared version guidance for provider-owned CLI backend protocol requirements. */
import { coerce as coerceSemver } from "semver";
import { compareValidSemver } from "../infra/semver.js";
import type { CliBackendLiveSessionRequirement } from "../plugins/cli-backend.types.js";

type CliBackendVersionSupport =
  | { status: "supported"; version: string }
  | { status: "unsupported"; version: string }
  | { status: "unknown" };

/** Compare human CLI version output with the provider's published compatibility floor. */
export function resolveCliBackendVersionSupport(
  versionOutput: string | undefined,
  requirement: CliBackendLiveSessionRequirement,
): CliBackendVersionSupport {
  const parsed = versionOutput ? coerceSemver(versionOutput)?.version : undefined;
  if (!parsed) {
    return { status: "unknown" };
  }
  const comparison = compareValidSemver(parsed, requirement.minimumVersion);
  if (comparison === null) {
    return { status: "unknown" };
  }
  return {
    status: comparison < 0 ? "unsupported" : "supported",
    version: parsed,
  };
}

/** Actionable guidance shared by setup, Doctor, and live-session failures. */
export function formatCliBackendUpdateGuidance(params: {
  label: string;
  requirement: CliBackendLiveSessionRequirement;
  version?: string;
}): string {
  const found = params.version ? `; found ${params.version}` : "";
  return `${params.label} ${params.requirement.minimumVersion} or newer is required${found}. Run \`${params.requirement.updateCommand}\`, restart OpenClaw, and retry.`;
}
