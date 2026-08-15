import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "../../lib/sessions/index.ts";
import type { ProviderUsageSummary } from "./data-types.ts";

export async function requestUsageSnapshot(
  client: GatewayBrowserClient,
  query: {
    startDate: string;
    endDate: string;
    scope: "instance" | "family";
    timeZone: "local" | "utc";
    agentId?: string;
  },
  signal?: AbortSignal,
) {
  const costParams = {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : { agentScope: "all" as const }),
    ...buildSessionUsageDateParams(query.timeZone),
  };
  const [result, costSummary, providerUsageSummary] = await Promise.all([
    requestSessionUsage(client, query),
    signal
      ? client.request<CostUsageSummary>("usage.cost", costParams, { signal })
      : client.request<CostUsageSummary>("usage.cost", costParams),
    (signal
      ? client.request<ProviderUsageSummary>("usage.status", undefined, { signal })
      : client.request<ProviderUsageSummary>("usage.status")
    ).catch(() => null),
  ]);
  return { result, costSummary, providerUsageSummary };
}
