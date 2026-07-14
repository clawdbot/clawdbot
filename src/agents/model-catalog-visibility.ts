/**
 * Resolves model catalog entries visible to browse/UI surfaces. Visibility
 * combines explicit policy, configured models, defaults, and runtime
 * auth-backed availability.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import {
  type ModelCatalogRoutePolicy,
  type ModelCatalogRouteProjection,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";
import {
  buildConfiguredModelCatalog,
  dedupeModelCatalogEntries,
  modelCatalogLogicalKey,
} from "./model-selection-shared.js";
import {
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "./model-visibility-policy.js";

type ModelCatalogVisibilityView = "default" | "configured" | "all";
export type ModelCatalogAuthChecker = (
  provider: string,
  ref?: ModelAuthAvailabilityRef,
) => boolean | Promise<boolean>;
type ModelCatalogEntryAuthChecker = (entry: ModelCatalogEntry) => boolean | Promise<boolean>;

type LogicalModelCatalogEntryState = {
  authBacked: boolean;
  compatible: boolean;
  preferred: boolean;
  routeManaged: boolean;
  routeProjection: ModelCatalogRouteProjection;
};

/** Maps one shared auth evaluation into logical catalog selection state. */
export function resolveLogicalModelCatalogEntryState(params: {
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  authBacked?: boolean;
  routePolicy: ModelCatalogRoutePolicy;
}): LogicalModelCatalogEntryState {
  const routeManaged = params.evaluation.routeResolution !== null;
  const selectedRoute = params.evaluation.selectedRoute;
  const routeProjection: ModelCatalogRouteProjection = !routeManaged
    ? { kind: "unmanaged" }
    : selectedRoute
      ? { kind: "selected", route: selectedRoute, policy: params.routePolicy }
      : { kind: "unresolved", policy: params.routePolicy };
  return {
    authBacked: params.authBacked ?? params.evaluation.availability === true,
    compatible: params.evaluation.routeResolution?.kind !== "incompatible",
    preferred: selectedRoute ? params.routePolicy.matchesRoute(params.entry, selectedRoute) : false,
    routeManaged,
    routeProjection,
  };
}

async function modelCatalogEntryHasProviderAuth(
  providerAuthChecker: ModelCatalogAuthChecker,
  entry: ModelCatalogEntry,
): Promise<boolean> {
  return await providerAuthChecker(entry.provider, {
    modelId: entry.id,
    api: entry.api,
    baseUrl: entry.baseUrl,
  });
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}

function resolveLogicalKey(
  entry: Pick<ModelCatalogEntry, "provider" | "id">,
  routePolicy: ModelCatalogRoutePolicy,
): string {
  return routePolicy.resolveIdentity(entry)?.key ?? modelCatalogLogicalKey(entry);
}

function dedupeLogicalModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
  routePolicy: ModelCatalogRoutePolicy,
) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = resolveLogicalKey(entry, routePolicy);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Resolve catalog entries visible for one view, honoring explicit visibility
 * policy, configured models, and providers with usable auth.
 */
type ResolveVisibleModelCatalogParams = {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  view?: ModelCatalogVisibilityView;
  runtimeAuthDiscovery?: boolean;
  providerAuthChecker?: ModelCatalogAuthChecker;
  entryAuthChecker?: ModelCatalogEntryAuthChecker;
};

async function resolveVisibleModelCatalogWithPolicy(
  params: ResolveVisibleModelCatalogParams,
  policy: ModelVisibilityPolicy,
): Promise<ModelCatalogEntry[]> {
  if (params.view === "all") {
    return params.catalog;
  }

  const buildDefaultVisibleCatalog = async () => {
    const configuredCatalog = sortModelCatalogEntries(
      buildConfiguredModelCatalog({ cfg: params.cfg }),
    );
    let checkEntryAuth = params.entryAuthChecker;
    if (!checkEntryAuth) {
      const providerAuthChecker =
        params.providerAuthChecker ??
        createProviderAuthChecker({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          agentId: params.agentId,
          env: params.env,
          allowPluginSyntheticAuth: params.runtimeAuthDiscovery,
          discoverExternalCliAuth: params.runtimeAuthDiscovery,
        });
      checkEntryAuth = (entry) => modelCatalogEntryHasProviderAuth(providerAuthChecker, entry);
    }
    const authBackedCatalog: ModelCatalogEntry[] = [];
    for (const entry of params.catalog) {
      if (await checkEntryAuth(entry)) {
        authBackedCatalog.push(entry);
      }
    }
    return sortModelCatalogEntries(
      dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]),
    );
  };

  // When policy allows wildcards, the default visible set includes configured
  // entries plus auth-backed entries. Otherwise the policy operates on explicit
  // catalog selections only.
  const defaultVisibleCatalog =
    policy.allowAny || policy.hasProviderWildcards ? await buildDefaultVisibleCatalog() : [];
  return sortModelCatalogEntries(
    dedupeModelCatalogEntries(
      policy.visibleCatalog({
        catalog: params.catalog,
        defaultVisibleCatalog,
        view: params.view,
      }),
    ),
  );
}

/** Resolves logical rows while keeping provider-owned physical route precedence. */
export async function resolveLogicalVisibleModelCatalog(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
  workspaceDir?: string;
  view?: ModelCatalogVisibilityView;
  policy?: ModelVisibilityPolicy;
  routePolicy: ModelCatalogRoutePolicy;
  routeVariants?: readonly ModelCatalogEntry[];
  evaluateEntry(
    entry: ModelCatalogEntry,
    routeVariants: readonly ModelCatalogEntry[],
  ): Promise<LogicalModelCatalogEntryState>;
}): Promise<ModelCatalogEntry[]> {
  const policy =
    params.policy ??
    createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: params.catalog,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
  const projectionCatalog =
    params.routeVariants && params.routeVariants.length > 0 ? params.routeVariants : params.catalog;
  const routeVariantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of projectionCatalog) {
    const key = resolveLogicalKey(entry, params.routePolicy);
    const variants = routeVariantsByKey.get(key) ?? [];
    variants.push(entry);
    routeVariantsByKey.set(key, variants);
  }
  const resolveEntryRouteVariants = (entry: ModelCatalogEntry) =>
    routeVariantsByKey.get(resolveLogicalKey(entry, params.routePolicy)) ?? [entry];
  const stateByKey = new Map<string, Promise<LogicalModelCatalogEntryState>>();
  const evaluateEntry = async (entry: ModelCatalogEntry) => {
    const key = resolveLogicalKey(entry, params.routePolicy);
    let pending = stateByKey.get(key);
    if (!pending) {
      const variants = resolveEntryRouteVariants(entry);
      pending = params.evaluateEntry(variants[0] ?? entry, variants);
      stateByKey.set(key, pending);
    }
    const state = await pending;
    const selectedRoute =
      state.routeProjection.kind === "selected" ? state.routeProjection.route : undefined;
    return {
      ...state,
      preferred: selectedRoute ? params.routePolicy.matchesRoute(entry, selectedRoute) : false,
    };
  };
  const normalizePolicyKey = (key: string) => {
    const slashIndex = key.indexOf("/");
    return slashIndex > 0
      ? resolveLogicalKey(
          { provider: key.slice(0, slashIndex), id: key.slice(slashIndex + 1) },
          params.routePolicy,
        )
      : key;
  };
  const configuredKeys = new Set([...policy.configuredKeys].map(normalizePolicyKey));
  const retainedKeys = new Set([...policy.retainedKeys].map(normalizePolicyKey));
  const projectEntries = async (entries: readonly ModelCatalogEntry[]) => {
    const projected = await Promise.all(
      entries.map(async (entry) => {
        const state = await evaluateEntry(entry);
        const overrides = resolveConfiguredModelCatalogOverrides({
          cfg: params.cfg,
          entry,
          policy: params.routePolicy,
        });
        return projectModelCatalogEntryForRoute({
          entry,
          projection: state.routeProjection,
          catalog: resolveEntryRouteVariants(entry),
          ...(overrides ? { overrides } : {}),
        });
      }),
    );
    return sortModelCatalogEntries(dedupeLogicalModelCatalogEntries(projected, params.routePolicy));
  };
  if (params.view === "all") {
    return await projectEntries(params.catalog);
  }

  const catalogKeys = new Set(
    params.catalog.map((entry) => resolveLogicalKey(entry, params.routePolicy)),
  );
  const visible = (
    await resolveVisibleModelCatalogWithPolicy(
      {
        cfg: params.cfg,
        catalog: params.catalog,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        view: params.view,
        runtimeAuthDiscovery: false,
        entryAuthChecker: async (entry) => (await evaluateEntry(entry)).authBacked,
      },
      policy,
    )
  ).filter((entry) => {
    const key = resolveLogicalKey(entry, params.routePolicy);
    return catalogKeys.has(key) || configuredKeys.has(key);
  });
  const retained = params.catalog.filter((entry) =>
    retainedKeys.has(resolveLogicalKey(entry, params.routePolicy)),
  );
  const preferredKeys = new Set(
    [...visible, ...retained].map((entry) => resolveLogicalKey(entry, params.routePolicy)),
  );
  const preferred: ModelCatalogEntry[] = [];
  const routeBacked = new Set<ModelCatalogEntry>();
  for (const entry of params.catalog) {
    const key = resolveLogicalKey(entry, params.routePolicy);
    const preferredKey = preferredKeys.has(key);
    const wildcardRoute =
      policy.allowAny || policy.providerWildcards.has(normalizeProviderId(entry.provider));
    if (!preferredKey && !wildcardRoute) {
      continue;
    }
    const state = await evaluateEntry(entry);
    if (!state.compatible && !configuredKeys.has(key)) {
      continue;
    }
    if (state.preferred && preferredKey) {
      preferred.push(entry);
    }
    if (wildcardRoute && state.routeManaged && state.authBacked) {
      routeBacked.add(entry);
    }
  }

  const kept: ModelCatalogEntry[] = [];
  for (const entry of visible) {
    const key = resolveLogicalKey(entry, params.routePolicy);
    const state = await evaluateEntry(entry);
    const configured = configuredKeys.has(key);
    if (
      (state.compatible || configured) &&
      (!state.routeManaged || configured || routeBacked.has(entry))
    ) {
      kept.push(entry);
    }
  }
  // Physical route rows can share one logical provider/id. Selected-route rows
  // must lead this merge so dedupe cannot retain sibling-route metadata instead.
  return await projectEntries([...preferred, ...kept, ...retained, ...routeBacked]);
}
