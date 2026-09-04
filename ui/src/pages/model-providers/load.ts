// Fetches the gateway signals behind the Models settings page.
// Each source degrades independently: unavailable usage data must not blank
// the provider list.
import type { SessionModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ConfigSnapshot,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import { requestSessionUsage } from "../../lib/sessions/usage.ts";

/** Local session-spend window shown on each card. */
export const MODEL_PROVIDERS_COST_DAYS = 30;

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerOutcomes: ModelCatalogProviderOutcome[];
  catalogError: string | null;
  config: Record<string, unknown> | null;
  providerUsage: ProviderUsageRequestResult | null;
  costByProvider: SessionModelUsage[] | null;
  updatedAt: number | null;
  error: string | null;
};

type RequestResult<T> = { ok: true; result: T } | { ok: false; error: unknown };

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  models: null,
  providerOutcomes: [],
  catalogError: null,
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
  return formatUiError(error, "request failed");
}

function settleRequest<T>(promise: Promise<T>): Promise<RequestResult<T>> {
  return promise.then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  );
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts: { agentId: string; refresh?: boolean; signal?: AbortSignal },
): Promise<ModelProvidersData> {
  const loadConfiguredCatalog = (loadOpts: { preparedOnly?: true; refresh?: true }) =>
    settleRequest(
      loadModelCatalog(client, {
        agentId: opts.agentId,
        ...loadOpts,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
  const catalogRefresh = opts.refresh ? loadConfiguredCatalog({ refresh: true }) : undefined;
  const catalogLoad = catalogRefresh
    ? catalogRefresh.then((refreshResult) =>
        refreshResult.ok ? refreshResult : loadConfiguredCatalog({ preparedOnly: true }),
      )
    : loadConfiguredCatalog({ preparedOnly: true });
  const [authStatus, catalog, refreshResult, config] = await Promise.all([
    settleRequest(loadModelAuthStatus(client, opts)),
    catalogLoad,
    catalogRefresh ?? Promise.resolve(undefined),
    client
      .request<ConfigSnapshot>("config.get", {}, { signal: opts.signal })
      .then((snapshot) => resolveEditableSnapshotConfig(snapshot))
      .catch(() => null),
  ]);
  return {
    authStatus:
      authStatus.ok && Array.isArray(authStatus.result?.providers) ? authStatus.result : null,
    models: catalog.ok ? catalog.result.models : null,
    providerOutcomes: catalog.ok ? (catalog.result.providerOutcomes ?? []) : [],
    catalogError:
      refreshResult && !refreshResult.ok
        ? errorMessage(refreshResult.error)
        : catalog.ok
          ? null
          : errorMessage(catalog.error),
    config,
    providerUsage: null,
    costByProvider: null,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok
      ? (authStatus.result.unavailable?.message ?? null)
      : errorMessage(authStatus.error),
  };
}

export function loadModelProviderUsage(
  client: GatewayBrowserClient,
  signal: AbortSignal,
): Promise<ProviderUsageRequestResult> {
  return requestProviderUsage(client, { signal });
}

export function loadModelProviderCost(
  client: GatewayBrowserClient,
  signal: AbortSignal,
): Promise<SessionModelUsage[] | null> {
  return requestSessionUsage(
    client,
    {
      startDate: localDate(MODEL_PROVIDERS_COST_DAYS - 1),
      endDate: localDate(0),
      scope: "family",
      timeZone: "local",
    },
    { signal },
  )
    .then((result) => result?.aggregates?.byProvider ?? null)
    .catch((error: unknown) => {
      if (signal.aborted) {
        throw error;
      }
      return null;
    });
}
