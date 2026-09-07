import { isDeepStrictEqual } from "node:util";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import { revalidateSetupInferenceOwner } from "./revalidate-inference-owner.js";
import {
  type ActivateSetupInferenceDeps,
  type ActivateSetupInferenceResult,
  SetupInferenceOwnerDriftError,
} from "./setup-inference-core.js";
import type {
  SystemAgentOwnerPluginArtifactSnapshot,
  SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

export function validateSetupInferenceOwnerEvidence(params: {
  runner: "cli" | "embedded";
  configuredHarnessId?: string;
  auth: AgentExecutionAuthBinding;
}): Extract<ActivateSetupInferenceResult, { ok: false }> | undefined {
  if (
    !params.auth.authFingerprint &&
    (!params.auth.runtimeOwnerFingerprint ||
      !params.auth.runtimeOwnerKind ||
      !params.auth.runtimeOwnerId?.trim())
  ) {
    return {
      ok: false,
      status: "unknown",
      error:
        "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse. No model or credential route was saved.",
    };
  }
  if (
    params.runner === "cli" &&
    (!params.auth.runtimeArtifactFingerprint || !params.auth.runtimeArtifactId?.trim())
  ) {
    return {
      ok: false,
      status: "unknown",
      error:
        "Inference succeeded, but its CLI executable/package artifact could not be safely reused. No model or credential route was saved.",
    };
  }
  if (params.runner === "embedded") {
    const successfulHarnessId = params.auth.agentHarnessId?.trim();
    const configuredHarnessId = params.configuredHarnessId?.trim();
    if (
      !successfulHarnessId ||
      (configuredHarnessId !== undefined &&
        configuredHarnessId !== "auto" &&
        successfulHarnessId !== configuredHarnessId)
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its exact agent harness could not be safely reused. No model or credential route was saved.",
      };
    }
    if (
      successfulHarnessId !== "openclaw" &&
      (params.auth.runtimeOwnerKind !== "plugin-harness" ||
        params.auth.runtimeOwnerId?.trim() !== successfulHarnessId ||
        !params.auth.runtimeArtifactFingerprint ||
        !params.auth.runtimeArtifactId?.trim())
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its agent harness artifact could not be safely reused. No model or credential route was saved.",
      };
    }
  }
  return undefined;
}

function hasSameOwnerPluginArtifacts(
  binding: SystemAgentVerifiedInferenceBinding,
  snapshot: SystemAgentOwnerPluginArtifactSnapshot,
): boolean {
  return (
    isDeepStrictEqual(binding.ownerPluginIds, snapshot.ownerPluginIds) &&
    isDeepStrictEqual(binding.ownerPluginArtifacts, snapshot.ownerPluginArtifacts)
  );
}

/**
 * Revalidate the successful probe's owner against current config. Any drift
 * throws SetupInferenceOwnerDriftError, which activation returns as an auth
 * failure result — a throw that escapes here would crash the onboarding ladder.
 */
export async function revalidateStableSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot | undefined;
  deps: ActivateSetupInferenceDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  let binding: SystemAgentVerifiedInferenceBinding;
  try {
    binding = await revalidateSetupInferenceOwner({
      route: params.route,
      auth: params.auth,
      ownerPluginIds: params.stagedOwnerPluginArtifacts?.ownerPluginIds,
      deps: params.deps,
    });
  } catch (error) {
    throw new SetupInferenceOwnerDriftError(
      `The verified inference owner changed before activation completed. Retry the inference check. (${formatErrorMessage(error)})`,
      { cause: error },
    );
  }
  if (
    !params.stagedOwnerPluginArtifacts ||
    !hasSameOwnerPluginArtifacts(binding, params.stagedOwnerPluginArtifacts)
  ) {
    throw new SetupInferenceOwnerDriftError(
      "The verified inference owner changed before activation completed. Retry the inference check. (The owner plugin runtime changed during its live test.)",
    );
  }
  return binding;
}
