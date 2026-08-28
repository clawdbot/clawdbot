/** Projects physical catalog rows for browse/presentation; never runtime execution. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

type ModelCatalogRouteMatcher = (
  entry: ModelCatalogEntry,
  route: ProviderModelRouteCandidate,
) => boolean;

type ModelCatalogLogicalIdentity = { id: string; key: string };

/** Provider-owned catalog equivalence and exact physical-route matching. */
export type ModelCatalogRoutePolicy = {
  resolveIdentity(
    entry: Pick<ModelCatalogEntry, "provider" | "id">,
  ): ModelCatalogLogicalIdentity | null;
  matchesRoute: ModelCatalogRouteMatcher;
};

export type ModelCatalogRouteProjection =
  | { kind: "unmanaged" }
  | { kind: "unresolved"; policy: ModelCatalogRoutePolicy }
  | {
      kind: "selected";
      route: ProviderModelRouteCandidate;
      policy: ModelCatalogRoutePolicy;
    };

type ModelCatalogLogicalOverrides = Partial<
  Pick<
    ModelCatalogEntry,
    | "name"
    | "contextWindow"
    | "contextTokens"
    | "reasoning"
    | "configuredReasoning"
    | "thinkingLevelMap"
    | "input"
  >
>;

function normalizeExactModelId(value: string): string {
  return splitTrailingAuthProfile(value).model.trim().toLowerCase();
}

/** Reads explicit logical capability overrides without re-resolving auth. */
export function resolveConfiguredModelCatalogOverrides(params: {
  cfg: OpenClawConfig;
  entry: Pick<ModelCatalogEntry, "provider" | "id">;
  policy?: ModelCatalogRoutePolicy;
}): ModelCatalogLogicalOverrides | undefined {
  const provider = normalizeProviderId(params.entry.provider);
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  if (!providerConfig) {
    return undefined;
  }
  const configuredIdentity = params.policy?.resolveIdentity(params.entry);
  const normalizeConfiguredModelId = (modelId: string) =>
    params.policy?.resolveIdentity({ provider: params.entry.provider, id: modelId })?.key ??
    normalizeExactModelId(modelId);
  const model = resolveMergedModelProviderModels({
    models: providerConfig.models,
    normalizeModelId: normalizeConfiguredModelId,
  }).get(configuredIdentity?.key ?? normalizeExactModelId(params.entry.id));
  const overrides: ModelCatalogLogicalOverrides = {
    ...(model?.name ? { name: model.name } : {}),
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model?.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model?.reasoning !== undefined ? { configuredReasoning: model.reasoning } : {}),
    ...(model?.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model?.input !== undefined ? { input: model.input } : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function sameLogicalModel(
  a: ModelCatalogEntry,
  identity: ModelCatalogLogicalIdentity,
  policy: ModelCatalogRoutePolicy,
): boolean {
  return policy.resolveIdentity(a)?.key === identity.key;
}

function logicalIdentity(
  entry: ModelCatalogEntry,
  id: string,
  name?: string,
  lifecycleEntry: ModelCatalogEntry = entry,
): ModelCatalogEntry {
  return {
    id,
    name: name ?? id,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(lifecycleEntry.providerOrder !== undefined
      ? { providerOrder: lifecycleEntry.providerOrder }
      : {}),
    ...(lifecycleEntry.status ? { status: lifecycleEntry.status } : {}),
    ...(lifecycleEntry.statusReason ? { statusReason: lifecycleEntry.statusReason } : {}),
    ...(lifecycleEntry.replaces ? { replaces: lifecycleEntry.replaces } : {}),
    ...(lifecycleEntry.replacedBy ? { replacedBy: lifecycleEntry.replacedBy } : {}),
  };
}

function applyLogicalOverrides(
  entry: ModelCatalogEntry,
  overrides: ModelCatalogLogicalOverrides | undefined,
): ModelCatalogEntry {
  return overrides ? { ...entry, ...overrides } : entry;
}

/** Finds the exact physical row that supplied a selected provider route. */
export function findModelCatalogRouteDonor(params: {
  entry: ModelCatalogEntry;
  route: ProviderModelRouteCandidate;
  policy: ModelCatalogRoutePolicy;
  catalog?: readonly ModelCatalogEntry[];
}): ModelCatalogEntry | undefined {
  const identity = params.policy.resolveIdentity(params.entry);
  const physicalDonor = identity
    ? params.catalog?.find(
        (candidate) =>
          sameLogicalModel(candidate, identity, params.policy) &&
          params.policy.matchesRoute(candidate, params.route),
      )
    : undefined;
  if (physicalDonor) {
    return physicalDonor;
  }
  return params.policy.matchesRoute(params.entry, params.route) ? params.entry : undefined;
}

/**
 * Builds one allowlisted logical catalog row.
 *
 * Selected-route capabilities come only from a physical row accepted by the
 * provider-owned matcher. Unresolved managed routes expose identity only.
 * Auth, runtime, request overrides, and other private transport facts never
 * enter the returned catalog shape.
 */
export function projectModelCatalogEntryForRoute(params: {
  entry: ModelCatalogEntry;
  projection: ModelCatalogRouteProjection;
  catalog?: readonly ModelCatalogEntry[];
  overrides?: ModelCatalogLogicalOverrides;
}): ModelCatalogEntry {
  if (params.projection.kind === "unmanaged") {
    return applyLogicalOverrides(params.entry, params.overrides);
  }
  const identity = params.projection.policy.resolveIdentity(params.entry) ?? {
    id: splitTrailingAuthProfile(params.entry.id).model,
    key: `${normalizeProviderId(params.entry.provider)}/${normalizeExactModelId(params.entry.id)}`,
  };
  if (params.projection.kind === "unresolved") {
    return applyLogicalOverrides(
      logicalIdentity(params.entry, identity.id, params.entry.name),
      params.overrides,
    );
  }

  const { policy, route } = params.projection;
  const donor = findModelCatalogRouteDonor({
    entry: params.entry,
    route,
    policy,
    catalog: params.catalog,
  });
  const projected = logicalIdentity(
    params.entry,
    identity.id,
    donor?.name ?? params.entry.name,
    donor ?? params.entry,
  );
  return applyLogicalOverrides(
    {
      ...projected,
      api: route.api,
      baseUrl: route.baseUrl,
      ...(donor?.contextWindow !== undefined ? { contextWindow: donor.contextWindow } : {}),
      ...(donor?.contextTokens !== undefined ? { contextTokens: donor.contextTokens } : {}),
      ...(donor?.reasoning !== undefined ? { reasoning: donor.reasoning } : {}),
      ...(donor?.thinkingLevelMap ? { thinkingLevelMap: donor.thinkingLevelMap } : {}),
      ...(donor?.input !== undefined ? { input: donor.input } : {}),
    },
    params.overrides,
  );
}
