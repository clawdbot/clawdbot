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
    throw new Error(
      `Prepared runtime auth route ${route.provider}/${route.modelId} does not match target ${params.provider}/${params.modelId}.`,
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
    throw new Error(
      route
        ? `Caller-provided ${params.provider}/${params.modelId} metadata does not match its prepared ${route.authRequirement} route.`
        : `Caller-provided model metadata does not match ${params.provider}/${params.modelId}.`,
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
  if (
    !resolved.model ||
    normalizeProviderId(resolved.model.provider ?? "") !== normalizeProviderId(params.provider) ||
    canonicalizeProviderModelId(params.provider, resolved.model.id ?? "") !==
      canonicalizeProviderModelId(params.provider, params.modelId) ||
    (route &&
      !modelMatchesPreparedTarget({
        model: resolved.model,
        provider: params.provider,
        modelId: params.modelId,
        route,
      }))
  ) {
    throw new Error(
      resolved.error ??
        (route
          ? `Unable to materialize ${params.provider}/${params.modelId} for its prepared ${route.authRequirement} route.`
          : `Unable to rematerialize ${params.provider}/${params.modelId} for its resolved auth profile.`),
    );
  }
  return resolved.model;
}
