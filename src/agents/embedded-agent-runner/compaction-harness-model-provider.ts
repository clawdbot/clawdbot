import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { AgentHarnessPreparedModelProvider } from "../harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "../harness/support.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../runtime-plan/types.js";

export function buildCompactionHarnessModelProvider(params: {
  model?: ProviderRuntimeModel;
  plan?: AgentRuntimeAuthPlan;
  attempt?: PreparedAgentRuntimeAuthAttempt;
}): AgentHarnessPreparedModelProvider {
  const route = params.plan?.modelRoute;
  return {
    api: route?.api ?? params.model?.api,
    baseUrl: route?.baseUrl ?? params.model?.baseUrl,
    ...resolveAgentHarnessPreparedRouteSupport(params.plan),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            source: params.attempt?.kind === "implicit" ? undefined : params.attempt?.kind,
          }),
        }
      : {}),
  };
}
