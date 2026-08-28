import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary } from "../../api/types.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "../../lib/sessions/usage.ts";

type UsageSnapshotValue = {
  result: Awaited<ReturnType<typeof requestSessionUsage>>;
  costSummary: CostUsageSummary;
  providerUsage: ProviderUsageSnapshot;
};

type UsageSnapshotFailure = {
  cause: unknown;
  providerUsage: ProviderUsageSnapshot;
};

export type ProviderUsageSnapshot =
  | { state: "pending" }
  | { state: "settled"; result: ProviderUsageRequestResult };

export type UsageSnapshotResult = Result<UsageSnapshotValue, UsageSnapshotFailure>;

export function providerUsageFromSnapshotResult(
  result: UsageSnapshotResult,
): ProviderUsageSnapshot {
  return result.ok ? result.value.providerUsage : result.error.providerUsage;
}

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
): Promise<UsageSnapshotResult> {
  const costParams = {
    startDate: query.startDate,
    endDate: query.endDate,
    ...(query.agentId ? { agentId: query.agentId } : { agentScope: "all" as const }),
    ...buildSessionUsageDateParams(query.timeZone),
  };
  let settledProviderUsage: ProviderUsageSnapshot | undefined;
  const providerUsagePromise = requestProviderUsage(client, signal ? { signal } : undefined).then(
    (result): ProviderUsageSnapshot => (settledProviderUsage = { state: "settled", result }),
  );
  try {
    const [result, costSummary, providerUsage] = await Promise.all([
      requestSessionUsage(client, query),
      signal
        ? client.request<CostUsageSummary>("usage.cost", costParams, { signal })
        : client.request<CostUsageSummary>("usage.cost", costParams),
      providerUsagePromise,
    ]);
    return ok({ result, costSummary, providerUsage });
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    return err({ cause, providerUsage: settledProviderUsage ?? { state: "pending" } });
  }
}
