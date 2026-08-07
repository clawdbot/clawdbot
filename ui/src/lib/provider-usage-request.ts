// One boundary for the usage.status RPC: a null summary is the gateway's
// answer, while `failed` records that the request itself never answered.
// Consumers must not render the two the same way (silent empty panels).
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

export type ProviderUsageFetch = {
  summary: UsageSummary | null;
  failed: boolean;
};

export function requestProviderUsage(
  client: GatewayBrowserClient,
  opts?: { signal?: AbortSignal },
): Promise<ProviderUsageFetch> {
  const pending = opts?.signal
    ? client.request<UsageSummary>("usage.status", undefined, { signal: opts.signal })
    : client.request<UsageSummary>("usage.status");
  return pending.then(
    (summary) => ({ summary, failed: false }),
    () => ({ summary: null, failed: true }),
  );
}
