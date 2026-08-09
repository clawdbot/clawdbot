import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldPreferProviderRuntimeResolvedModel } from "../../plugins/provider-runtime.js";
import {
  resolveProviderModelMaterializationAuthMode,
  resolveProviderModelRouteAuthRequirement,
  type ProviderModelRouteMaterializationAuthMode,
} from "../provider-model-route-auth.js";
import { materializePreparedRuntimeModel } from "./materialize-model.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  type PreparedAgentRuntimeAuthAttempt,
} from "./prepare-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

type RuntimeRouteModel = {
  provider?: string;
  id?: string;
  api?: string | null;
  baseUrl?: string;
};

type RuntimeModelAuthSelection =
  | { authProfileId: string }
  | { authProfileMode: ProviderModelRouteMaterializationAuthMode }
  | undefined;

export function providerUsesCredentialScopedModelMetadata(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return shouldPreferProviderRuntimeResolvedModel({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
    context: {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.modelId,
    },
  });
}

/** Reuses forwarded model auth only when the prepared plan owns the exact target. */
export function resolveReusableRuntimeModelAuth(params: {
  plan?: AgentRuntimeAuthPlan;
  provider: string;
  modelId: string;
  authProfileId?: string;
}): {
  plan?: AgentRuntimeAuthPlan;
  authProfileId?: string;
  modelAuth: RuntimeModelAuthSelection;
} {
  const plan =
    params.plan &&
    agentRuntimeAuthPlanMatchesTarget(params.plan, {
      provider: params.provider,
      modelId: params.modelId,
    })
      ? params.plan
      : undefined;
  const authProfileId = params.authProfileId ?? plan?.forwardedAuthProfileId;
  const authProfileMode = resolveProviderModelMaterializationAuthMode(plan?.selectedAuthMode);
  const modelAuth =
    authProfileId !== undefined
      ? { authProfileId }
      : authProfileMode !== undefined
        ? { authProfileMode }
        : undefined;
  return { plan, authProfileId, modelAuth };
}

/** Direct auth after a profile attempt must drop credential-scoped model metadata. */
export function shouldForceDirectAuthFallbackModelResolve(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  priorProfileAttempted: boolean;
}): boolean {
  return params.attempt.kind === "direct" && params.priorProfileAttempted;
}

/** Re-resolves when the selected profile or direct credential can change provider metadata. */
function shouldForceCredentialScopedModelResolve(
  plan: Pick<AgentRuntimeAuthPlan, "forwardedAuthProfileId" | "selectedAuthMode">,
  requestedProfileId?: string,
  providerUsesProfileScopedModelMetadata = false,
): boolean {
  return Boolean(
    plan.forwardedAuthProfileId ||
    requestedProfileId ||
    (providerUsesProfileScopedModelMetadata && plan.selectedAuthMode),
  );
}

/** Re-resolves metadata whenever the prepared credential can change provider limits. */
function shouldMaterializeAuthPlanModel(
  plan: Pick<AgentRuntimeAuthPlan, "forwardedAuthProfileId" | "modelRoute" | "selectedAuthMode">,
  requestedProfileId?: string,
  providerUsesProfileScopedModelMetadata = false,
): boolean {
  return Boolean(
    plan.modelRoute ||
    shouldForceCredentialScopedModelResolve(
      plan,
      requestedProfileId,
      providerUsesProfileScopedModelMetadata,
    ),
  );
}

export function resolveCredentialScopedAuthAttemptModelDecision(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  priorProfileAttempted: boolean;
  requestedProfileId?: string;
  providerUsesProfileScopedModelMetadata: boolean;
}) {
  const forceResolve = shouldForceDirectAuthFallbackModelResolve(params);
  const shouldMaterialize =
    shouldMaterializeAuthPlanModel(
      params.attempt.plan,
      params.requestedProfileId,
      params.providerUsesProfileScopedModelMetadata,
    ) || forceResolve;
  return {
    forceResolve,
    shouldMaterialize,
    authRequirement:
      params.attempt.plan.modelRoute?.authRequirement ??
      (shouldMaterialize && params.providerUsesProfileScopedModelMetadata
        ? resolveProviderModelRouteAuthRequirement(params.attempt.plan.selectedAuthMode)
        : undefined),
  };
}

export function hasPreparedAuthAttemptModelMetadata(params: {
  attempts: readonly PreparedAgentRuntimeAuthAttempt[];
  providerUsesProfileScopedModelMetadata: boolean;
}): boolean {
  return params.attempts.some(
    (attempt) =>
      (params.providerUsesProfileScopedModelMetadata &&
        (attempt.kind === "profile" || Boolean(attempt.plan.forwardedAuthProfileId))) ||
      Boolean(attempt.plan.modelRoute) ||
      attempt.allowAuthProfileFallback !== undefined,
  );
}

export function createPreparedRuntimeModelMaterializer<Model extends RuntimeRouteModel>(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  getModel(): Model;
  nativeModelOwned: boolean;
  requestedProfileId?: string;
  providerUsesProfileScopedModelMetadata: boolean;
  resolveModel(request: {
    config: OpenClawConfig;
    authProfileId?: string;
    authProfileMode?: ProviderModelRouteMaterializationAuthMode;
  }): Promise<{ model?: Model | null; error?: string }>;
}) {
  const materializedRouteModels = new WeakMap<AgentRuntimeAuthPlan, Promise<Model>>();
  const materializeUncached = async (
    plan: AgentRuntimeAuthPlan,
    forceResolve = false,
  ): Promise<Model> => {
    const model = params.getModel();
    // Native harness sessions own their model tuple. Route preparation may
    // attest auth/transport, but must not rediscover or replace that model.
    if (params.nativeModelOwned) {
      return model;
    }
    return (
      (await materializePreparedRuntimeModel({
        plan,
        provider: params.provider,
        modelId: params.modelId,
        config: params.config,
        model,
        // Credential-scoped providers must replace metadata whenever the
        // prepared profile or direct auth source changes.
        forceResolve:
          forceResolve ||
          shouldForceCredentialScopedModelResolve(
            plan,
            params.requestedProfileId,
            params.providerUsesProfileScopedModelMetadata,
          ),
        resolveModel: (request) => params.resolveModel(request),
      })) ?? model
    );
  };
  const materialize = (plan: AgentRuntimeAuthPlan): Promise<Model> => {
    if (!plan.modelRoute) {
      return materializeUncached(plan);
    }
    const cached = materializedRouteModels.get(plan);
    if (cached) {
      return cached;
    }
    // Prepared plans are immutable within one run. Carry their exact model
    // tuple into auth initialization instead of repeating provider discovery.
    const materialized = materializeUncached(plan);
    materializedRouteModels.set(plan, materialized);
    return materialized;
  };
  return { materialize, materializeUncached };
}
