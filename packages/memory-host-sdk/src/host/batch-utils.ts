// Memory Host SDK helper module supports batch utils behavior.
import type { SsrFPolicy } from "./ssrf-policy.js";

// Common HTTP and grouping helpers for remote embedding batch clients.

/** Minimal HTTP client config needed by batch providers. */
export type BatchHttpClientConfig = {
  baseUrl?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
};

/** Normalize batch API base URLs by removing one trailing slash. */
export function normalizeBatchBaseUrl(client: BatchHttpClientConfig): string {
  return client.baseUrl?.replace(/\/$/, "") ?? "";
}

/** Build request headers, preserving caller auth and controlling JSON/form content type. */
export function buildBatchHeaders(
  client: Pick<BatchHttpClientConfig, "headers">,
  params: { json: boolean },
): Record<string, string> {
  const headers = client.headers ? { ...client.headers } : {};
  if (params.json) {
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  } else {
    delete headers["Content-Type"];
    delete headers["content-type"];
  }
  return headers;
}

/** Split provider requests into max-sized groups while preserving order. */
export function splitBatchRequests<T>(requests: T[], maxRequests: number): T[][] {
  if (requests.length <= maxRequests) {
    return [requests];
  }
  const groups: T[][] = [];
  for (let i = 0; i < requests.length; i += maxRequests) {
    groups.push(requests.slice(i, i + maxRequests));
  }
  return groups;
}
