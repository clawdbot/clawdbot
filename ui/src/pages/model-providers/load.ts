// Fetches the gateway signals behind the Model Providers settings page.
// Each source degrades independently: a missing usage hook or an older
// gateway must not blank the provider list.
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, ModelAuthStatusResult, ModelCatalogEntry } from "../../api/types.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { requestSessionUsage } from "../../lib/sessions/index.ts";
import { loadModels } from "../chat/models.ts";

/** Local session-spend window shown on each card. */
export const MODEL_PROVIDERS_COST_DAYS = 30;

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  catalogModels: ModelCatalogEntry[] | null;
  config: Record<string, unknown> | null;
  providerUsage: UsageSummary | null;
  costByProvider: SessionModelUsage[] | null;
  updatedAt: number | null;
  error: string | null;
};

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  models: null,
  catalogModels: null,
  config: null,
  providerUsage: null,
  costByProvider: null,
  updatedAt: null,
  error: null,
};

function localDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("model providers");
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" ? error : "request failed";
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean; agentId?: string },
): Promise<ModelProvidersData> {
  const [authStatus, models, catalogModels, config, providerUsage, costByProvider] =
    await Promise.all([
      loadModelAuthStatus(client, opts).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      loadModels(client, opts).catch(() => null),
      client
        .request<{ models?: ModelCatalogEntry[] }>("models.list", {
          view: "all",
          includeProviderCapabilities: true,
        })
        .then((result) => result?.models ?? null)
        .catch(() => null),
      client
        .request<ConfigSnapshot>("config.get", {})
        .then((snapshot) => resolveEditableSnapshotConfig(snapshot))
        .catch(() => null),
      client.request<UsageSummary>("usage.status").catch(() => null),
      requestSessionUsage(client, {
        startDate: localDate(MODEL_PROVIDERS_COST_DAYS - 1),
        endDate: localDate(0),
        scope: "family",
        timeZone: "local",
      })
        .then((result) => result?.aggregates?.byProvider ?? null)
        .catch(() => null),
    ]);
  return {
    authStatus: authStatus.ok ? authStatus.result : null,
    models,
    catalogModels,
    config,
    providerUsage,
    costByProvider,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok ? null : errorMessage(authStatus.error),
  };
}
