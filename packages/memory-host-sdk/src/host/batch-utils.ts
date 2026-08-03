// Memory Host SDK helper module supports batch utils behavior.
import type { SsrFPolicy } from "./ssrf-policy.js";

// Common HTTP and grouping helpers for remote embedding batch clients.

/** Minimal HTTP client config needed by batch providers. */
export type BatchHttpClientConfig = {
  baseUrl?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
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

const jsonlEncoder = new TextEncoder();

function estimateJsonlLineBytes(request: unknown): number {
  return jsonlEncoder.encode(JSON.stringify(request) ?? "").byteLength;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function splitBatchRequestsByLimits<T>(
  requests: T[],
  limits: { maxRequests: number; maxJsonlBytes?: number },
): T[][] {
  const maxRequests = normalizePositiveInteger(limits.maxRequests) ?? 1;
  const maxJsonlBytes = normalizePositiveInteger(limits.maxJsonlBytes);
  if (requests.length === 0) {
    return maxJsonlBytes ? [] : [requests];
  }

  const groups: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const request of requests) {
    const requestBytes = estimateJsonlLineBytes(request);
    const separatorBytes = current.length === 0 ? 0 : 1;
    const wouldExceedRequests = current.length >= maxRequests;
    const wouldExceedBytes =
      maxJsonlBytes !== undefined &&
      current.length > 0 &&
      currentBytes + separatorBytes + requestBytes > maxJsonlBytes;
    if (current.length > 0 && (wouldExceedRequests || wouldExceedBytes)) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }

    currentBytes += (current.length === 0 ? 0 : 1) + requestBytes;
    current.push(request);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}
