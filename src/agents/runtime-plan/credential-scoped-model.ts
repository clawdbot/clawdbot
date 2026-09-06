import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { shouldPreferProviderRuntimeResolvedModel } from "../../plugins/provider-runtime.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
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

const ROUTE_MODEL_MEMO_MAX_ENTRIES = 64;

// Plans are fresh objects each turn; only their model-selection facts are reusable.
function routeModelMemoKey(
  plan: AgentRuntimeAuthPlan,
  params: {
    provider: string;
    modelId: string;
    requestedProfileId?: string;
    providerUsesProfileScopedModelMetadata: boolean;
  },
): string {
  const route = plan.modelRoute;
  return JSON.stringify([
    params.provider,
    params.modelId,
    plan.forwardedAuthProfileId ?? "",
    plan.selectedAuthMode ?? "",
    route?.api ?? "",
    route?.baseUrl ?? "",
    route?.authRequirement ?? "",
    params.requestedProfileId?.trim() ?? "",
    params.providerUsesProfileScopedModelMetadata,
  ]);
}

export function createPreparedRuntimeModelMaterializer<Model extends RuntimeRouteModel>(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  getModel(): Model;
  nativeModelOwned: boolean;
  requestedProfileId?: string;
  providerUsesProfileScopedModelMetadata: boolean;
  /** Dynamic preparation owns its refresh cadence and must run on every turn. */
  providerOwnsDynamicModelRefresh?: boolean;
  /** Optional generation-owned memo; omit to keep run-local caching only. */
  generationRouteModelMemo?: Map<string, Promise<Model>>;
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
        workspaceDir: params.workspaceDir,
        metadataSnapshot: params.metadataSnapshot,
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
    // Only resolver output can cross turns. Native-owned and unchanged base
    // models belong to their individual run, while dynamic hooks own refresh.
    const willResolve = shouldForceCredentialScopedModelResolve(
      plan,
      params.requestedProfileId,
      params.providerUsesProfileScopedModelMetadata,
    );
    const memo =
      params.nativeModelOwned || !willResolve || params.providerOwnsDynamicModelRefresh
        ? undefined
        : params.generationRouteModelMemo;
    if (!plan.modelRoute && !memo) {
      return materializeUncached(plan);
    }
    if (plan.modelRoute) {
      const cached = materializedRouteModels.get(plan);
      if (cached) {
        return cached;
      }
    }
    const materialized = memo
      ? getOrCreatePromise(
          memo,
          routeModelMemoKey(plan, params),
          () => {
            // FIFO bounds retained metadata for a long-lived generation. The
            // shared promise helper evicts only its own rejection, even after churn.
            if (memo.size >= ROUTE_MODEL_MEMO_MAX_ENTRIES) {
              const oldest = memo.keys().next().value;
              if (oldest !== undefined) {
                memo.delete(oldest);
              }
            }
            return materializeUncached(plan);
          },
          { cacheRejections: false },
        )
      : materializeUncached(plan);
    if (plan.modelRoute) {
      materializedRouteModels.set(plan, materialized);
    }
    return materialized;
  };
  return { materialize, materializeUncached };
}
