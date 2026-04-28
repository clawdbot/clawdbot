import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { buildAllowedModelSet, buildConfiguredModelCatalog } from "../../agents/model-selection.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = "default" | "configured" | "all";

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}

function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = context.getRuntimeConfig();
      const view = resolveModelsListView(params);
      if (view === "all") {
        respond(true, { models: catalog }, undefined);
        return;
      }
      const allowed = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const configuredCatalog =
        view === "configured" ? sortModelCatalogEntries(buildConfiguredModelCatalog({ cfg })) : [];
      const models =
        view === "configured" && allowed.allowAny && configuredCatalog.length > 0
          ? configuredCatalog
          : allowed.allowedCatalog.length > 0
            ? allowed.allowedCatalog
            : configuredCatalog.length > 0
              ? configuredCatalog
              : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
