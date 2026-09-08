/**
 * Resolves model catalog entries visible to browse/UI surfaces. Visibility
 * combines explicit policy, configured models, defaults, and runtime
 * auth-backed availability.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import {
  type ModelCatalogRoutePolicy,
  type ModelCatalogRouteProjection,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
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

type LogicalModelCatalogEntryState = {
  authBacked: boolean;
  compatible: boolean;
  routeManaged: boolean;
  routeProjection: ModelCatalogRouteProjection;
};

/** Maps one shared auth evaluation into logical catalog selection state. */
export function resolveLogicalModelCatalogEntryState(params: {
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
    routeManaged,
    routeProjection,
  };
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(compareModelCatalogEntries);
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

function isPickerVisibleCatalogEntry(
  entry: ModelCatalogEntry,
  configuredKeys: ReadonlySet<string>,
  routePolicy: ModelCatalogRoutePolicy,
): boolean {
  // Deprecated and disabled rows stay selectable but are picker-hidden.
  // Exact configured refs always remain visible so pinned models never disappear.
  return (
    (entry.status !== "deprecated" && entry.status !== "disabled") ||
    configuredKeys.has(resolveLogicalKey(entry, routePolicy))
  );
}

type LogicalModelCatalogParams = {
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
};

/** Resolves logical rows while keeping provider-owned physical route precedence. */
export async function resolveLogicalVisibleModelCatalog(
  params: LogicalModelCatalogParams & {
    evaluateEntry(
      entry: ModelCatalogEntry,
      routeVariants: readonly ModelCatalogEntry[],
    ): Promise<LogicalModelCatalogEntryState>;
  },
): Promise<ModelCatalogEntry[]> {
  const read = await prepareLogicalVisibleModelCatalog({
    ...params,
    prepareEntry: async (entry, variants) => {
      const state = await params.evaluateEntry(entry, variants);
      return () => state;
    },
  });
  return read();
}

/** Prepare host facts once; observe revocable state only in the synchronous publication. */
export async function prepareLogicalVisibleModelCatalog(
  params: LogicalModelCatalogParams & {
    prepareEntry(
      entry: ModelCatalogEntry,
      routeVariants: readonly ModelCatalogEntry[],
    ): Promise<() => LogicalModelCatalogEntryState>;
  },
): Promise<() => ModelCatalogEntry[]> {
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
  const keyOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    resolveLogicalKey(entry, params.routePolicy);
  const projectionCatalog = params.routeVariants?.length ? params.routeVariants : params.catalog;
  const routeVariantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of projectionCatalog) {
    const key = keyOf(entry);
    const variants = routeVariantsByKey.get(key) ?? [];
    variants.push(entry);
    routeVariantsByKey.set(key, variants);
  }
  const variantsOf = (entry: ModelCatalogEntry) => routeVariantsByKey.get(keyOf(entry)) ?? [entry];
  const normalizePolicyKey = (key: string) => {
    const slash = key.indexOf("/");
    return slash > 0 ? keyOf({ provider: key.slice(0, slash), id: key.slice(slash + 1) }) : key;
  };
  const configuredKeys = new Set([...policy.configuredKeys].map(normalizePolicyKey));
  const retainedKeys = new Set([...policy.retainedKeys].map(normalizePolicyKey));
  const retained = params.catalog.filter((entry) => retainedKeys.has(keyOf(entry)));
  const wildcard = policy.allowAny || policy.hasProviderWildcards;
  const configuredCatalog = wildcard
    ? sortModelCatalogEntries(buildConfiguredModelCatalog({ cfg: params.cfg }))
    : [];
  const candidates =
    params.view === "all"
      ? params.catalog
      : [
          ...(wildcard ? params.catalog : []),
          ...configuredCatalog,
          ...policy.allowedCatalog,
          ...retained,
        ];
  const readers = new Map<string, () => LogicalModelCatalogEntryState>();
  for (const entry of candidates) {
    const key = keyOf(entry);
    if (!readers.has(key)) {
      const variants = variantsOf(entry);
      readers.set(key, await params.prepareEntry(variants[0] ?? entry, variants));
    }
  }
  const catalogKeys = new Set(params.catalog.map(keyOf));
  const projections = new Map<
    ModelCatalogEntry,
    {
      overrides: ReturnType<typeof resolveConfiguredModelCatalogOverrides>;
      rows: Map<
        | ModelCatalogRouteProjection["kind"]
        | Extract<ModelCatalogRouteProjection, { kind: "selected" }>["route"],
        ModelCatalogEntry
      >;
    }
  >();
  return () => {
    // Membership and row availability consume this one observation after every await.
    const states = new Map([...readers].map(([key, read]) => [key, read()]));
    const getEntryState = (entry: ModelCatalogEntry) => {
      const state = states.get(keyOf(entry));
      if (!state) {
        throw new Error("Model catalog publication omitted prepared entry state");
      }
      return state;
    };
    const projectEntries = (entries: readonly ModelCatalogEntry[]) => {
      const projected = entries.map((entry) => {
        const projection = getEntryState(entry).routeProjection;
        let cached = projections.get(entry);
        if (!cached) {
          cached = {
            overrides: resolveConfiguredModelCatalogOverrides({
              cfg: params.cfg,
              entry,
              policy: params.routePolicy,
            }),
            rows: new Map(),
          };
          projections.set(entry, cached);
        }
        const route = projection.kind === "selected" ? projection.route : projection.kind;
        let row = cached.rows.get(route);
        if (!row) {
          row = projectModelCatalogEntryForRoute({
            entry,
            projection,
            catalog: variantsOf(entry),
            ...(cached.overrides ? { overrides: cached.overrides } : {}),
          });
          cached.rows.set(route, row);
        }
        return row;
      });
      return sortModelCatalogEntries(
        dedupeLogicalModelCatalogEntries(projected, params.routePolicy),
      );
    };
    if (params.view === "all") {
      return projectEntries(params.catalog);
    }
    const defaultVisibleCatalog = wildcard
      ? sortModelCatalogEntries(
          dedupeModelCatalogEntries([
            ...configuredCatalog,
            ...params.catalog.filter((entry) => getEntryState(entry).authBacked),
          ]),
        )
      : [];
    const visible = sortModelCatalogEntries(
      dedupeModelCatalogEntries(
        policy.visibleCatalog({
          catalog: params.catalog,
          defaultVisibleCatalog,
          view: params.view,
        }),
      ),
    ).filter((entry) => catalogKeys.has(keyOf(entry)) || configuredKeys.has(keyOf(entry)));
    const preferredKeys = new Set([...visible, ...retained].map(keyOf));
    const preferred: ModelCatalogEntry[] = [];
    const routeBacked = new Set<ModelCatalogEntry>();
    for (const entry of params.catalog) {
      const key = keyOf(entry);
      const preferredKey = preferredKeys.has(key);
      const wildcardRoute =
        policy.allowAny ||
        (policy.hasProviderWildcards &&
          policy.allowsByWildcard({ provider: entry.provider, model: entry.id }));
      if (!preferredKey && !wildcardRoute) {
        continue;
      }
      const state = getEntryState(entry);
      if (!state.compatible && !configuredKeys.has(key)) {
        continue;
      }
      if (
        preferredKey &&
        state.routeProjection.kind === "selected" &&
        params.routePolicy.matchesRoute(entry, state.routeProjection.route)
      ) {
        preferred.push(entry);
      }
      if (wildcardRoute && state.routeManaged && state.authBacked) {
        routeBacked.add(entry);
      }
    }
    const kept = visible.filter((entry) => {
      const state = getEntryState(entry);
      const configured = configuredKeys.has(keyOf(entry));
      return (
        (state.compatible || configured) &&
        (!state.routeManaged || configured || routeBacked.has(entry))
      );
    });
    // Selected physical routes must lead dedupe so sibling metadata cannot win.
    return projectEntries([...preferred, ...kept, ...retained, ...routeBacked]).filter((entry) =>
      isPickerVisibleCatalogEntry(entry, configuredKeys, params.routePolicy),
    );
  };
}
