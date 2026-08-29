import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
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

async function loadUsageRouteData(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<UsageRouteData> {
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
  const pending: UsageRouteData = {
    gateway,
    gatewaySnapshot,
    query,
    result: null,
    costSummary: null,
    providerUsage: { state: "pending" },
    loadedAtMs: null,
    error: null,
  };
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return pending;
  }

  try {
    const { providerUsageFromSnapshotResult, requestUsageSnapshot } =
      await import("./request-usage-snapshot.ts");
    // Loading can outlive the route, selected scope, or Gateway transport.
    // Preserve the admission snapshot and never start requests for a retired owner.
    const current = gateway.snapshot;
    if (
      !options.shouldRun() ||
      current.phase !== "connected" ||
      current.client !== gatewaySnapshot.client ||
      current.hello !== gatewaySnapshot.hello ||
      context.agentSelection.state.scopeId !== query.agentId
    ) {
      return pending;
    }
    const snapshot = await requestUsageSnapshot(
      gatewaySnapshot.client,
      { ...query, agentId: query.agentId ?? undefined },
      options.signal,
    );
    if (snapshot.ok) {
      return {
        ...pending,
        result: snapshot.value.result,
        costSummary: snapshot.value.costSummary,
        providerUsage: snapshot.value.providerUsage,
        loadedAtMs: Date.now(),
      };
    }
    return {
      ...pending,
      providerUsage: providerUsageFromSnapshotResult(snapshot),
      error: errorMessage(snapshot.error.cause),
    };
  } catch (error) {
    return { ...pending, error: errorMessage(error) };
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
