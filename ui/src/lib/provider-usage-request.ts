// One boundary for the usage.status RPC. A successful empty response is valid data;
// request failure remains a separate closed Result arm for consumer views.
// Never convert cancellation into that arm: Lit Task discards superseded work.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

type ProviderUsageRequestFailure = { kind: "request-failed" };

export type ProviderUsageRequestResult = Result<UsageSummary, ProviderUsageRequestFailure>;

export async function requestProviderUsage(
  client: GatewayBrowserClient,
  opts?: { signal?: AbortSignal },
): Promise<ProviderUsageRequestResult> {
  try {
    const summary = opts?.signal
      ? await client.request<UsageSummary>("usage.status", undefined, { signal: opts.signal })
      : await client.request<UsageSummary>("usage.status");
    return ok<UsageSummary, ProviderUsageRequestFailure>(summary);
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw error;
    }
    return err<UsageSummary, ProviderUsageRequestFailure>({ kind: "request-failed" });
  }
}
