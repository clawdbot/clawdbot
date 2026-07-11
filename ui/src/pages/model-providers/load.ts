// Fetches the gateway signals behind the Model Providers settings page.
// Each source degrades independently: a missing usage hook or an older
// gateway must not blank the provider list.
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../../api/types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { requestSessionUsage } from "../../lib/sessions/index.ts";

/** Local session-spend window shown on each card. */
export const MODEL_PROVIDERS_COST_DAYS = 30;

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerUsage: UsageSummary | null;
  costByProvider: SessionModelUsage[] | null;
  updatedAt: number | null;
  error: string | null;
};

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  models: null,
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
  opts?: { refresh?: boolean },
): Promise<ModelProvidersData> {
  const [authStatus, models, providerUsage, costByProvider] = await Promise.all([
    loadModelAuthStatus(client, opts).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    client
      .request<{ models?: ModelCatalogEntry[] }>("models.list", {})
      .then((result) => result?.models ?? null)
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
    providerUsage,
    costByProvider,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok ? null : errorMessage(authStatus.error),
  };
}
