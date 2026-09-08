/** Keeps raw catalog operands and logical row projection on the same captured input. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  findModelCatalogRouteDonor,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
  type ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildAllowedModelSet } from "./model-selection-shared.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

/** Captures route variants without filtering the raw catalog used by execution callers. */
export function createModelCatalogView(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  routeVariants?: readonly ModelCatalogEntry[];
}) {
  const variantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of params.routeVariants ?? params.catalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    const variants = variantsByKey.get(key) ?? [];
    variants.push(entry);
    variantsByKey.set(key, variants);
  }
  const variantsOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    variantsByKey.get(resolveModelCatalogIdentityKey(entry));
  const logicalEntries = new Map<string, ModelCatalogEntry>();
  for (const entry of params.catalog) {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!logicalEntries.has(key)) {
      logicalEntries.set(key, entry);
    }
  }
  return {
    // A terminal history or setting callback needs this operand, not projected public rows.
    catalog: params.catalog,
    logicalEntries: [...logicalEntries.values()],
    variantsOf,
    selectAgent(paramsForAgent: { agentId?: string; defaultProvider: string }) {
      return buildAllowedModelSet({
        cfg: params.cfg,
        catalog: params.catalog,
        ...paramsForAgent,
      }).allowedCatalog;
    },
    project(entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation) {
      const projection: ModelCatalogRouteProjection =
        evaluation.routeResolution === null
          ? { kind: "unmanaged" }
          : evaluation.selectedRoute
            ? {
                kind: "selected",
                route: evaluation.selectedRoute,
                policy: openAIModelCatalogRoutePolicy,
              }
            : { kind: "unresolved", policy: openAIModelCatalogRoutePolicy };
      const variants = variantsOf(entry);
      const overrides = resolveConfiguredModelCatalogOverrides({
        cfg: params.cfg,
        entry,
        policy: openAIModelCatalogRoutePolicy,
      });
      return {
        entry: projectModelCatalogEntryForRoute({
          entry,
          projection,
          ...(variants ? { catalog: variants } : {}),
          ...(overrides ? { overrides } : {}),
        }),
        donor:
          projection.kind === "selected"
            ? findModelCatalogRouteDonor({
                entry,
                route: projection.route,
                policy: openAIModelCatalogRoutePolicy,
                ...(variants ? { catalog: variants } : {}),
              })
            : undefined,
      };
    },
  };
}

export type ModelCatalogView = ReturnType<typeof createModelCatalogView>;
