import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { CostUsageSummary } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "../../lib/sessions/index.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import type { UsageRouteData } from "./usage-page.ts";

function currentLocalDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("usage");
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" ? error : "request failed";
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
    agentId: null,
  };
  if (!gatewaySnapshot.connected || !gatewaySnapshot.client) {
    return {
      gateway,
      gatewaySnapshot,
      query,
      result: null,
      costSummary: null,
      providerUsageSummary: null,
      error: null,
    };
  }

  try {
    const [result, costSummary, providerUsageSummary] = await Promise.all([
      requestSessionUsage(gatewaySnapshot.client, {
        ...query,
        agentId: query.agentId ?? undefined,
      }),
      gatewaySnapshot.client.request<CostUsageSummary>("usage.cost", {
        startDate: query.startDate,
        endDate: query.endDate,
        agentScope: "all",
        ...buildSessionUsageDateParams(query.timeZone),
      }),
      gatewaySnapshot.client.request<ProviderUsageSummary>("usage.status").catch(() => null),
    ]);
    return {
      gateway,
      gatewaySnapshot,
      query,
      result,
      costSummary,
      providerUsageSummary,
      error: null,
    };
  } catch (error) {
    return {
      gateway,
      gatewaySnapshot,
      query,
      result: null,
      costSummary: null,
      providerUsageSummary: null,
      error: errorMessage(error),
    };
  }
}

export const page = definePage({
  id: "usage",
  path: "/usage",
  loader: loadUsageRouteData,
  component: () =>
    import("./usage-page.ts").then(() => ({
      header: true,
      render: (data: UsageRouteData | undefined) =>
        html`<openclaw-usage-page .routeData=${data}></openclaw-usage-page>`,
    })),
});
