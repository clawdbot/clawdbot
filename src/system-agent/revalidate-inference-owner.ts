// Rebuilds an exact verified inference owner after a successful live probe.
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
};

export async function revalidateSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  deps: RevalidationDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const createBinding =
    params.deps.createSystemAgentVerifiedInferenceBinding ??
    createSystemAgentVerifiedInferenceBinding;
  return await createBinding({
    configuredRoute: params.route,
    executionRoute: params.route,
    auth: params.auth,
    deps: params.deps,
  });
}
