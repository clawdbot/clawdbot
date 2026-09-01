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

/**
 * Generation-owned, value-keyed memo of materialized route models. Lives on
 * the prepared-model-runtime snapshot so every run of a generation shares it
 * (per-run wrappers spread the snapshot, carrying this reference through).
 * Invalidation is generation replacement: OpenClaw-published auth-profile
 * mutations and config publications rebuild the snapshot. Out-of-process
 * credential edits (e.g. an external CLI rewriting its own auth file) do not
 * publish, so only model METADATA can pin until the next publication —
 * credentials themselves are resolved fresh each turn.
 */
export type PreparedRuntimeRouteModelMemo = {
  get(key: string): Promise<RuntimeRouteModel> | undefined;
  set(key: string, value: Promise<RuntimeRouteModel>): void;
  delete(key: string): void;
};

const ROUTE_MODEL_MEMO_MAX_ENTRIES = 64;

export function createPreparedRuntimeRouteModelMemo(): PreparedRuntimeRouteModelMemo {
  const entries = new Map<string, Promise<RuntimeRouteModel>>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      if (!entries.has(key) && entries.size >= ROUTE_MODEL_MEMO_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
      entries.set(key, value);
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}

/**
 * Every decision-relevant input to route-model materialization. Plan objects
 * are minted fresh each turn, so identity keying can never hit across runs;
 * these values are what actually select the resolved model.
 */
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
    params.providerUsesProfileScopedModelMetadata ? "1" : "0",
  ]);
}

export function createPreparedRuntimeModelMaterializer<Model extends RuntimeRouteModel>(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  getModel(): Model;
  nativeModelOwned: boolean;
  requestedProfileId?: string;
  providerUsesProfileScopedModelMetadata: boolean;
  /** Dynamic preparation owns its refresh cadence and must run on every turn. */
  providerOwnsDynamicModelRefresh?: boolean;
  /** Optional generation-owned memo; omit to keep run-local caching only. */
  generationRouteModelMemo?: PreparedRuntimeRouteModelMemo;
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
    // Memoize ONLY guaranteed resolver output: when willResolve is true,
    // materialize-model either throws or returns resolveModel's result —
    // never the per-run base model, which must not be shared across runs.
    // Native-owned sessions always resolve to the per-run base, so they
    // never touch the memo either.
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
    const memoKey = memo ? routeModelMemoKey(plan, params) : undefined;
    if (memo && memoKey) {
      const generationHit = memo.get(memoKey);
      if (generationHit) {
        // One generation, one config, same decision inputs → same resolver
        // output. The Model-type cast is sound only because auth-plan is the
        // sole memo-passing call site; a second caller with a narrower Model
        // must not share this memo instance.
        // SAFETY: this memo is owned by the sole materializer call site and stores this Model.
        const hit = generationHit as Promise<Model>;
        if (plan.modelRoute) {
          materializedRouteModels.set(plan, hit);
        }
        return hit;
      }
    }
    // Prepared plans are immutable within one run. Carry their exact model
    // tuple into auth initialization instead of repeating provider discovery.
    const materialized = materializeUncached(plan);
    if (plan.modelRoute) {
      materializedRouteModels.set(plan, materialized);
    }
    if (memo && memoKey) {
      // SAFETY: Model is constrained to RuntimeRouteModel and promises are covariant here.
      memo.set(memoKey, materialized as Promise<RuntimeRouteModel>);
      // Resolution failures throw (materialize-model.ts); never pin a
      // rejection for the generation — but never evict a newer healthy entry.
      materialized.catch(() => {
        // SAFETY: same constrained promise identity stored immediately above.
        if (memo.get(memoKey) === (materialized as Promise<RuntimeRouteModel>)) {
          memo.delete(memoKey);
        }
      });
    }
    return materialized;
  };
  return { materialize, materializeUncached };
}
