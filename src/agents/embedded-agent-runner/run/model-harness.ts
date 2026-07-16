import type { Model } from "../../../llm/types.js";
import {
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
  type AgentHarnessPreparedModelProvider,
} from "../../harness/selection.js";
import {
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "../../harness/support.js";
import type { AgentHarness } from "../../harness/types.js";
import { resolveContextConfigProviderForRuntime } from "../../openai-routing.js";
import type { PreparedAgentRuntimeAuthAttempt } from "../../runtime-plan/prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "../../runtime-plan/types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./setup.js";

type HarnessSelectionContext = {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  requestStreamTransportOverrides?: "present";
  nativeModelOwnedHarnessId?: string;
};

export function resolveEmbeddedRunEffectiveModel(
  params: HarnessSelectionContext & {
    modelConfigProvider: string;
    agentHarnessId: string;
    runtimeModel: Model;
    nativeModelOwned: boolean;
  },
) {
  return resolveEmbeddedRuntimeModelPolicy({
    cfg: params.runParams.config,
    provider: params.provider,
    contextConfigProvider: resolveContextConfigProviderForRuntime({
      provider: params.modelConfigProvider,
      runtimeId: params.agentHarnessId,
      config: params.runParams.config,
    }),
    modelId: params.modelId,
    runtimeModel: params.runtimeModel,
    nativeModelOwned: params.nativeModelOwned,
  });
}

function buildHarnessModelProvider(
  params: HarnessSelectionContext & {
    model: Model;
    plan?: AgentRuntimeAuthPlan;
    preparedAuthAttempt?: PreparedAgentRuntimeAuthAttempt;
  },
): AgentHarnessPreparedModelProvider {
  const route = params.plan?.modelRoute;
  const routeSupport = resolveAgentHarnessPreparedRouteSupport(params.plan);
  const requestTransportOverrides =
    params.requestStreamTransportOverrides ?? routeSupport.requestTransportOverrides;
  return {
    api: route?.api ?? params.model.api,
    baseUrl: route?.baseUrl ?? params.model.baseUrl,
    ...(requestTransportOverrides ? { requestTransportOverrides } : {}),
    ...(routeSupport.runtimePolicy ? { runtimePolicy: routeSupport.runtimePolicy } : {}),
    ...(params.plan
      ? {
          preparedAuth: resolveAgentHarnessPreparedAuthSupport({
            plan: params.plan,
            ...(params.preparedAuthAttempt?.kind === "profile" ||
            params.preparedAuthAttempt?.kind === "direct"
              ? { source: params.preparedAuthAttempt.kind }
              : {}),
          }),
        }
      : {}),
  };
}

function assertPinnedHarness(
  nativeModelOwnedHarnessId: string | undefined,
  selected: AgentHarness,
  subject: string,
): void {
  if (nativeModelOwnedHarnessId && selected.id !== nativeModelOwnedHarnessId) {
    throw new Error(
      `${subject} changed the session-pinned agent harness from "${nativeModelOwnedHarnessId}" to "${selected.id}".`,
    );
  }
}

export function selectEmbeddedRunHarness(
  params: HarnessSelectionContext & {
    model: Model;
    plan?: AgentRuntimeAuthPlan;
    preparedAuthAttempt?: PreparedAgentRuntimeAuthAttempt;
  },
): AgentHarness {
  const selected = selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
    modelProvider: buildHarnessModelProvider(params),
    config: params.runParams.config,
    agentId: params.runParams.agentId,
    sessionKey: params.runParams.sessionKey,
    agentHarnessId: params.runParams.agentHarnessId,
    agentHarnessRuntimeOverride: params.runParams.agentHarnessRuntimeOverride,
  });
  assertPinnedHarness(params.nativeModelOwnedHarnessId, selected, "Prepared model route");
  return selected;
}

export function selectEmbeddedRunHarnessForPreparedAttempts(
  params: HarnessSelectionContext & {
    model: Model;
    attempts: readonly PreparedAgentRuntimeAuthAttempt[];
  },
): AgentHarness {
  const selected = selectAgentHarnessForPreparedModelProviders({
    provider: params.provider,
    modelId: params.modelId,
    modelProviders: params.attempts.map((attempt) => {
      const route = attempt.plan.modelRoute;
      const model = route
        ? { ...params.model, api: route.api, baseUrl: route.baseUrl }
        : params.model;
      return buildHarnessModelProvider({
        ...params,
        model,
        plan: attempt.plan,
        preparedAuthAttempt: attempt,
      });
    }),
    config: params.runParams.config,
    agentId: params.runParams.agentId,
    sessionKey: params.runParams.sessionKey,
    agentHarnessId: params.runParams.agentHarnessId,
    agentHarnessRuntimeOverride: params.runParams.agentHarnessRuntimeOverride,
  });
  assertPinnedHarness(params.nativeModelOwnedHarnessId, selected, "Prepared auth routes");
  return selected;
}
