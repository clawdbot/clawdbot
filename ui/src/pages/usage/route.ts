import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { providerUsageFromSnapshotResult, requestUsageSnapshot } from "./request-usage-snapshot.ts";
import type { UsageRouteData } from "./usage-page.ts";

function currentLocalDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("usage");
  }
  return formatUiError(error, "request failed");
}

async function loadUsageRouteData(context: ApplicationContext): Promise<UsageRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const startDate = currentLocalDate();
  const query: UsageRouteData["query"] = {
    startDate,
    endDate: startDate,
    scope: "family",
    timeZone: "local",
    agentId: context.agentSelection.state.scopeId,
  };
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return {
      gateway,
      gatewaySnapshot,
      query,
      result: null,
      costSummary: null,
      providerUsage: { state: "pending" },
      loadedAtMs: null,
      error: null,
    };
  }

  try {
    const snapshot = await requestUsageSnapshot(gatewaySnapshot.client, {
      ...query,
      agentId: query.agentId ?? undefined,
    });
    if (snapshot.ok) {
      return {
        gateway,
        gatewaySnapshot,
        query,
        result: snapshot.value.result,
        costSummary: snapshot.value.costSummary,
        providerUsage: snapshot.value.providerUsage,
        loadedAtMs: Date.now(),
        error: null,
      };
    }
    return {
      gateway,
      gatewaySnapshot,
      query,
      result: null,
      costSummary: null,
      providerUsage: providerUsageFromSnapshotResult(snapshot),
      loadedAtMs: null,
      error: errorMessage(snapshot.error.cause),
    };
  } catch (error) {
    return {
      gateway,
      gatewaySnapshot,
      query,
      result: null,
      costSummary: null,
      providerUsage: { state: "pending" },
      loadedAtMs: null,
      error: errorMessage(error),
    };
  }
}

export const page = definePage({
  ...routePageSpec("usage"),
  loader: loadUsageRouteData,
  component: () =>
    import("./usage-page.ts").then(() => ({
      header: true,
      render: (data: UsageRouteData | undefined) =>
        html`<openclaw-usage-page .routeData=${data}></openclaw-usage-page>`,
    })),
});
