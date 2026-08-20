import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "../../lib/sessions/index.ts";

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
  const [result, costSummary, providerUsage] = await Promise.all([
    requestSessionUsage(client, query),
    signal
      ? client.request<CostUsageSummary>("usage.cost", costParams, { signal })
      : client.request<CostUsageSummary>("usage.cost", costParams),
    requestProviderUsage(client, signal ? { signal } : undefined),
  ]);
  return { result, costSummary, providerUsage };
}
