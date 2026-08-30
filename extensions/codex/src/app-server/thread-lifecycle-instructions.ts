import {
  CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY,
  CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
} from "./session-binding.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

/** Persists one snapshot for eligible turns while leaving isolated runs eligible to upgrade. */
export function captureAgentInstructions(
  params: Pick<
    CodexStartOrResumeThreadParams,
    | "params"
    | "agentWorkspaceDeveloperInstructions"
    | "agentWorkspaceDeveloperInstructionsAllowed"
    | "projectInstructionsUnavailableToGateway"
  >,
  fallbackInstructions?: string | null,
  nativeProjectInstructionSources?: readonly string[],
) {
  if (
    params.agentWorkspaceDeveloperInstructionsAllowed === false ||
    params.params.bootstrapContextMode === "lightweight"
  ) {
    return {};
  }
  if (
    fallbackInstructions === CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY ||
    (params.projectInstructionsUnavailableToGateway === true &&
      nativeProjectInstructionSources !== undefined &&
      nativeProjectInstructionSources.length > 0)
  ) {
    return {
      agentWorkspaceDeveloperInstructions: CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
      projectInstructionsUnavailableToGateway: true as const,
    };
  }
  return {
    agentWorkspaceDeveloperInstructions:
      params.agentWorkspaceDeveloperInstructions !== undefined
        ? params.agentWorkspaceDeveloperInstructions
        : (fallbackInstructions ?? CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY),
  };
}
