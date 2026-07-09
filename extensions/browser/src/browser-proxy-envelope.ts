/**
 * Browser node-proxy response envelope shared by the node host and Gateway.
 */
import { parseBrowserErrorPayload, type BrowserNoDisplayErrorMetadata } from "./browser/errors.js";

/** Additive opt-in for structured browser route errors over node.invoke. */
export const BROWSER_PROXY_ERROR_ENVELOPE = "browser-v1" as const;

export type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

export type BrowserProxyErrorBody =
  | { error: string }
  | ({ error: string } & BrowserNoDisplayErrorMetadata);

export type BrowserProxySuccess = {
  result: unknown;
  files?: BrowserProxyFile[];
};

export type BrowserProxyFailure = {
  error: {
    status: number;
    body: BrowserProxyErrorBody;
  };
};

export type BrowserProxyEnvelope = BrowserProxySuccess | BrowserProxyFailure;

function normalizeBrowserProxyErrorBody(
  value: unknown,
  fallback?: string,
): BrowserProxyErrorBody | null {
  const parsed = parseBrowserErrorPayload(value);
  if (parsed) {
    return parsed;
  }
  return fallback ? { error: fallback } : null;
}

/** Build a route-failure envelope while allowing only closed Browser metadata. */
export function createBrowserProxyFailure(status: number, body: unknown): BrowserProxyFailure {
  return {
    error: {
      status,
      body: normalizeBrowserProxyErrorBody(body, `HTTP ${status}`) ?? { error: `HTTP ${status}` },
    },
  };
}

/** Parse an untrusted node response without forwarding arbitrary metadata. */
export function parseBrowserProxyFailure(value: unknown): BrowserProxyFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const candidate = error as { status?: unknown; body?: unknown };
  if (
    !Number.isInteger(candidate.status) ||
    (candidate.status as number) < 400 ||
    (candidate.status as number) > 599
  ) {
    return null;
  }
  const body = normalizeBrowserProxyErrorBody(candidate.body);
  if (!body) {
    return null;
  }
  return { error: { status: candidate.status as number, body } };
}
