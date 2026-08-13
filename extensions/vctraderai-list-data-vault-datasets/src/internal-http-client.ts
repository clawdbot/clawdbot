const ALLOWLIST_PATH_PATTERN =
  /^\/api\/v1\/workspaces\/[0-9a-f-]+\/data-vault(?:\/[^/]+\/preview)?$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
};
export type BffFetchFn = (path: string, options?: BffFetchOptions) => Promise<unknown>;

export class BffEgressViolation extends Error {
  constructor(path: string) {
    super(`vctraderai data-vault egress violation: ${path}`);
    this.name = "BffEgressViolation";
  }
}
export class BffRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`vctraderai data-vault request failed (${status}): ${detail}`);
    this.name = "BffRequestError";
  }
}

function assertAllowlistedPath(path: string): void {
  if (
    path.includes("\n") ||
    path.includes("\r") ||
    path.includes("\0") ||
    path.includes("/..") ||
    path.includes("../") ||
    path.includes("/./") ||
    !ALLOWLIST_PATH_PATTERN.test(path)
  ) {
    throw new BffEgressViolation(path);
  }
}
function buildQueryString(query: Record<string, string | undefined> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value) params.set(key, value);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
export function createBffFetch(
  deps: {
    fetchImpl?: typeof globalThis.fetch;
    threadId?: string;
  } = {},
): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new Error("vctraderai data-vault: global fetch is not available");
  return async (path, options = {}) => {
    assertAllowlistedPath(path);
    const token = process.env.PFM_AGENT_TOKEN;
    const response = await fetchImpl(
      `${process.env.PFM_BFF_BASE_URL ?? DEFAULT_BFF_BASE_URL}${path}${buildQueryString(options.query)}`,
      {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(deps.threadId ? { "x-openclaw-thread": deps.threadId } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal,
      },
    );
    if (!response.ok)
      throw new BffRequestError(response.status, (await response.text()).slice(0, 2000));
    return response.json();
  };
}
export const VCTRADERAI_DATA_VAULT_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;
