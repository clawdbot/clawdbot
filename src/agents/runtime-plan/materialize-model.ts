import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveProviderModelMaterializationAuthMode,
  resolveProviderModelRouteMaterializationAuthMode,
  type ProviderModelRouteMaterializationAuthMode,
} from "../provider-model-route-auth.js";
import {
  canonicalizeProviderModelId,
  modelMatchesProviderModelRoute,
  projectProviderModelRouteConfig,
} from "../provider-model-route.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

type RuntimeRouteModel = {
  provider?: string;
  id?: string;
  api?: string | null;
  baseUrl?: string;
};

export const PREPARED_RUNTIME_MODEL_MATERIALIZATION_REASON_CODES = [
  "resolved-model-missing",
  "resolved-provider-mismatch",
  "resolved-model-mismatch",
  "resolved-route-mismatch",
  "prepared-target-mismatch",
  "caller-model-mismatch",
] as const;

export type PreparedRuntimeModelMaterializationReasonCode =
  (typeof PREPARED_RUNTIME_MODEL_MATERIALIZATION_REASON_CODES)[number];

/** Secret-free identity and already-authoritative route classes for one failure. */
export type PreparedRuntimeModelMaterializationReason = {
  code: PreparedRuntimeModelMaterializationReasonCode;
  provider: string;
  modelId: string;
  actualProvider?: string;
  actualModelId?: string;
  api?: string;
  actualApi?: string;
  authRequirement?: NonNullable<AgentRuntimeAuthPlan["modelRoute"]>["authRequirement"];
};

const MATERIALIZATION_REASON_CODES = new Set<string>(
  PREPARED_RUNTIME_MODEL_MATERIALIZATION_REASON_CODES,
);

function modelMatchesPreparedTarget(params: {
  model: RuntimeRouteModel;
  provider: string;
  modelId: string;
  route: NonNullable<AgentRuntimeAuthPlan["modelRoute"]>;
}): boolean {
  const modelId = canonicalizeProviderModelId(params.provider, params.model.id ?? "");
  const targetModelId = canonicalizeProviderModelId(params.provider, params.modelId);
  return (
    normalizeProviderId(params.model.provider ?? "") === normalizeProviderId(params.provider) &&
    modelId === targetModelId &&
    modelMatchesProviderModelRoute({
      provider: params.provider,
      api: params.model.api,
      baseUrl: params.model.baseUrl,
      route: params.route,
    })
  );
}

type PreparedRuntimeModelRequest = {
  config: OpenClawConfig;
  authProfileId?: string;
  authProfileMode?: ProviderModelRouteMaterializationAuthMode;
};

function resolveNormalizedModelRef(provider: string, modelId: string) {
  return {
    provider: normalizeProviderId(provider),
    modelId: canonicalizeProviderModelId(provider, modelId),
  };
}

function resolveApiClass(api?: string | null): string | undefined {
  if (typeof api !== "string") {
    return undefined;
  }
  const trimmed = api.trim();
  return trimmed || undefined;
}

function resolveRouteClasses(route: NonNullable<AgentRuntimeAuthPlan["modelRoute"]>): {
  api?: string;
  authRequirement: NonNullable<AgentRuntimeAuthPlan["modelRoute"]>["authRequirement"];
} {
  const api = resolveApiClass(route.api);
  return {
    ...(api ? { api } : {}),
    authRequirement: route.authRequirement,
  };
}

function freezeMaterializationReason(
  reason: PreparedRuntimeModelMaterializationReason,
): PreparedRuntimeModelMaterializationReason {
  return Object.freeze({
    code: reason.code,
    provider: reason.provider,
    modelId: reason.modelId,
    ...(reason.actualProvider ? { actualProvider: reason.actualProvider } : {}),
    ...(reason.actualModelId ? { actualModelId: reason.actualModelId } : {}),
    ...(reason.api ? { api: reason.api } : {}),
    ...(reason.actualApi ? { actualApi: reason.actualApi } : {}),
    ...(reason.authRequirement ? { authRequirement: reason.authRequirement } : {}),
  });
}

/** Private typed failure for prepared-route materialization. Message stays user-facing. */
export class PreparedRuntimeModelMaterializationError extends Error {
  readonly reason: PreparedRuntimeModelMaterializationReason;

  constructor(message: string, reason: PreparedRuntimeModelMaterializationReason) {
    super(message);
    this.name = "Error";
    this.reason = freezeMaterializationReason(reason);
    Object.defineProperty(this, "reason", {
      value: this.reason,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

function resolveResolvedModelFailure(params: {
  model?: RuntimeRouteModel | null;
  provider: string;
  modelId: string;
  route?: AgentRuntimeAuthPlan["modelRoute"];
}): PreparedRuntimeModelMaterializationReason | undefined {
  const target = resolveNormalizedModelRef(params.provider, params.modelId);
  const routeClasses = params.route ? resolveRouteClasses(params.route) : {};
  if (!params.model) {
    return { code: "resolved-model-missing", ...target, ...routeClasses };
  }
  const actualProvider = normalizeProviderId(params.model.provider ?? "");
  if (actualProvider !== normalizeProviderId(params.provider)) {
    return {
      code: "resolved-provider-mismatch",
      ...target,
      actualProvider,
      ...routeClasses,
    };
  }
  const actualModelId = canonicalizeProviderModelId(params.provider, params.model.id ?? "");
  if (actualModelId !== canonicalizeProviderModelId(params.provider, params.modelId)) {
    return { code: "resolved-model-mismatch", ...target, actualModelId, ...routeClasses };
  }
  if (
    params.route &&
    !modelMatchesPreparedTarget({
      model: params.model,
      provider: params.provider,
      modelId: params.modelId,
      route: params.route,
    })
  ) {
    const actualApi = resolveApiClass(params.model.api);
    return {
      code: "resolved-route-mismatch",
      ...target,
      ...routeClasses,
      ...(actualApi ? { actualApi } : {}),
    };
  }
  return undefined;
}

/** Reads the private closed reason without changing external error text. */
export function readPreparedRuntimeModelMaterializationReason(
  error: unknown,
): PreparedRuntimeModelMaterializationReason | undefined {
  if (!(error instanceof PreparedRuntimeModelMaterializationError)) {
    return undefined;
  }
  if (!MATERIALIZATION_REASON_CODES.has(error.reason.code)) {
    return undefined;
  }
  return error.reason;
}

/** Resolves the exact model tuple selected by a prepared runtime auth plan. */
export async function materializePreparedRuntimeModel<Model extends RuntimeRouteModel>(params: {
  plan: AgentRuntimeAuthPlan;
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  model?: Model;
  /** Re-resolve when a later auth candidate changes credential-scoped model metadata. */
  forceResolve?: boolean;
  rejectMismatchedModel?: boolean;
  resolveModel(
    request: PreparedRuntimeModelRequest,
  ): Promise<{ model?: Model | null; error?: string }>;
}): Promise<Model | undefined> {
  const route = params.plan.modelRoute;
  if (!route && !params.forceResolve) {
    return params.model;
  }
  if (
    route &&
    (normalizeProviderId(route.provider) !== normalizeProviderId(params.provider) ||
      canonicalizeProviderModelId(route.provider, route.modelId) !==
        canonicalizeProviderModelId(params.provider, params.modelId))
  ) {
    throw new PreparedRuntimeModelMaterializationError(
      `Prepared runtime auth route ${route.provider}/${route.modelId} does not match target ${params.provider}/${params.modelId}.`,
      {
        code: "prepared-target-mismatch",
        ...resolveNormalizedModelRef(params.provider, params.modelId),
        actualProvider: normalizeProviderId(route.provider),
        actualModelId: canonicalizeProviderModelId(route.provider, route.modelId),
      },
    );
  }
  const callerModelMatches =
    params.model !== undefined &&
    normalizeProviderId(params.model.provider ?? "") === normalizeProviderId(params.provider) &&
    canonicalizeProviderModelId(params.provider, params.model.id ?? "") ===
      canonicalizeProviderModelId(params.provider, params.modelId) &&
    (!route ||
      modelMatchesPreparedTarget({
        model: params.model,
        provider: params.provider,
        modelId: params.modelId,
        route,
      }));
  if (callerModelMatches && !params.forceResolve) {
    return params.model;
  }
  if (params.model && !callerModelMatches && params.rejectMismatchedModel) {
    const callerProvider = normalizeProviderId(params.model.provider ?? "");
    const callerApi = resolveApiClass(params.model.api);
    throw new PreparedRuntimeModelMaterializationError(
      route
        ? `Caller-provided ${params.provider}/${params.modelId} metadata does not match its prepared ${route.authRequirement} route.`
        : `Caller-provided model metadata does not match ${params.provider}/${params.modelId}.`,
      {
        code: "caller-model-mismatch",
        ...resolveNormalizedModelRef(params.provider, params.modelId),
        ...(callerProvider ? { actualProvider: callerProvider } : {}),
        ...(params.model.id
          ? {
              actualModelId: canonicalizeProviderModelId(params.provider, params.model.id),
            }
          : {}),
        ...(route ? resolveRouteClasses(route) : {}),
        ...(callerApi ? { actualApi: callerApi } : {}),
      },
    );
  }

  const resolved = await params.resolveModel({
    config: route
      ? projectProviderModelRouteConfig({
          provider: params.provider,
          config: params.config,
          route,
        })
      : (params.config ?? {}),
    authProfileId: params.plan.forwardedAuthProfileId,
    authProfileMode: route
      ? resolveProviderModelRouteMaterializationAuthMode({
          mode: params.plan.selectedAuthMode,
          requirement: route.authRequirement,
        })
      : resolveProviderModelMaterializationAuthMode(params.plan.selectedAuthMode),
  });
  const resolvedFailure = resolveResolvedModelFailure({
    model: resolved.model,
    provider: params.provider,
    modelId: params.modelId,
    route,
  });
  if (resolvedFailure) {
    throw new PreparedRuntimeModelMaterializationError(
      resolved.error ??
        (route
          ? `Unable to materialize ${params.provider}/${params.modelId} for its prepared ${route.authRequirement} route.`
          : `Unable to rematerialize ${params.provider}/${params.modelId} for its resolved auth profile.`),
      resolvedFailure,
    );
  }
  return resolved.model as Model;
}
