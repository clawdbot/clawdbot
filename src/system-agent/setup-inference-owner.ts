import { isDeepStrictEqual } from "node:util";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import { revalidateSetupInferenceOwner } from "./revalidate-inference-owner.js";
import {
  type ActivateSetupInferenceDeps,
  SetupInferenceOwnerDriftError,
} from "./setup-inference-core.js";
import type {
  SystemAgentOwnerPluginArtifactSnapshot,
  SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

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
