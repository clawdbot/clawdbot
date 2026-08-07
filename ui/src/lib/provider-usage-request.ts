// One boundary for the usage.status RPC: a null summary is the gateway's
// answer, while `failed` records that the request itself never answered.
// Consumers must not render the two the same way (silent empty panels).
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

type ProviderUsageFetch = {
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
    // A cancelled request is the caller superseding its own work, not an
    // outage; reporting it as failed would render the unavailable notice
    // for every navigation or refresh that aborts an in-flight load. Both
    // task hosts abort only through supersession, which also discards the
    // settled result; a caller that aborts and still consumes the result
    // must classify the failure itself.
    () => ({ summary: null, failed: !opts?.signal?.aborted }),
  );
}
