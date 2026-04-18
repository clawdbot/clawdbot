import {
  fetchWithSsrFGuard,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";

export type UrbitFetchOptions = {
  baseUrl: string;
  path: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  auditContext?: string;
  pinDns?: boolean;
};

export async function urbitFetch(params: UrbitFetchOptions) {
  const validated = validateUrbitBaseUrl(params.baseUrl);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }

  const url = new URL(params.path, validated.baseUrl).toString();
  return await fetchWithSsrFGuard({
    url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    timeoutMs: params.timeoutMs,
    maxRedirects: params.maxRedirects,
    signal: params.signal,
    policy: params.ssrfPolicy,
    lookupFn: params.lookupFn,
    auditContext: params.auditContext,
    pinDns: params.pinDns,
  });
}
