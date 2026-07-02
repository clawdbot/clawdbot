// VC Trader AI BFF HTTP client (propose / staging variant).
//
// Wraps `globalThis.fetch` with an in-plugin allowlist guard that complements
// the Docker sandbox egress policy. The regex enforces the BFF surfaces this
// plugin is allowed to call: workspace-scoped paths (ADR 0078) AND the
// workspace-agnostic `/api/v1/openclaw/<segment>[/<rest>]` tool endpoints. For
// the cluster-C "propose" tools this includes the single-segment staging
// endpoint `/api/v1/openclaw/stage`, which the second branch now permits by
// making the trailing `/<rest>` optional (the read-only templates required two
// segments such as `catalogue/instruments`). Any non-allowlisted path is
// rejected before a socket is opened, so a buggy or malicious tool body cannot
// reach admin/system surfaces by accident.
//
// PROPOSE tools STAGE, they never execute: this client POSTs the proposal to
// the staging endpoint and the human reviews + applies it in the chat. The
// staging endpoint is the only mutating surface this client can reach, and it
// only enqueues a reviewable descriptor - it does not touch live trading state.
//
// We deliberately ship this helper per-plugin rather than via a shared package:
// the openclaw extensions boundary forbids cross-extension `src/` imports
// (`extensions/AGENTS.md`) and a single shared helper is also worth de-duping
// later, not pre-duping now.

const ALLOWLIST_PATH_PATTERN =
  /^(\/api\/v1\/workspaces\/[0-9a-f-]+\/.+|\/api\/v1\/openclaw\/[a-z]+(\/[a-z0-9-/]+)?)(\?.*)?$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};

export type BffError = {
  code: string;
  message: string;
  status: number;
};

export class BffEgressViolation extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`vctraderai bff egress violation: path ${path} is not in the allowlist`);
    this.name = "BffEgressViolation";
    this.path = path;
  }
}

export class BffRequestError extends Error {
  readonly detail: BffError;
  constructor(detail: BffError) {
    super(`vctraderai bff request failed: ${detail.code} (${detail.status}) ${detail.message}`);
    this.name = "BffRequestError";
    this.detail = detail;
  }
}

export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildQueryString(query: Record<string, string | undefined> | undefined): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

function assertAllowlistedPath(path: string): void {
  if (path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    throw new BffEgressViolation(path);
  }
  if (path.includes("/..") || path.includes("../") || path.includes("/./")) {
    throw new BffEgressViolation(path);
  }
  if (!ALLOWLIST_PATH_PATTERN.test(path)) {
    throw new BffEgressViolation(path);
  }
}

export type BffClientDeps = {
  fetchImpl?: typeof globalThis.fetch;
};

export function createBffFetch(deps: BffClientDeps = {}): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("vctraderai bff: global fetch is not available; Node >= 18 required");
  }
  return async function bffFetch(path: string, options: BffFetchOptions = {}): Promise<unknown> {
    assertAllowlistedPath(path);
    const baseUrl = readEnv("PFM_BFF_BASE_URL") ?? DEFAULT_BFF_BASE_URL;
    const token = readEnv("OPENCLAW_GATEWAY_TOKEN");
    const queryString = buildQueryString(options.query);
    const url = `${baseUrl}${path}${queryString}`;
    const hasBody = options.body !== undefined;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : undefined),
      ...(token ? { authorization: `Bearer ${token}` } : undefined),
      ...options.headers,
    };
    const response = await fetchImpl(url, {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    if (!response.ok) {
      const detail: BffError = {
        code: `bff_${response.status}`,
        message: response.statusText || `HTTP ${response.status}`,
        status: response.status,
      };
      throw new BffRequestError(detail);
    }
    return response.json();
  };
}

export const VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;
