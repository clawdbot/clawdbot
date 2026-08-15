// VC Trader AI BFF HTTP client.
//
// Wraps `globalThis.fetch` with an in-plugin allowlist guard that complements
// the Docker sandbox egress policy. The regex enforces the BFF surfaces this
// plugin is allowed to call: workspace-scoped paths (ADR 0078) AND the
// workspace-agnostic `/api/v1/openclaw/<segment>/*` read-only-tool endpoints
// (data, catalogue, ...) that the vctraderai read-only tools call. Any
// non-allowlisted path is rejected before a socket is opened, so a buggy or
// malicious tool body cannot reach admin/system surfaces by accident.
//
// We deliberately ship this helper per-plugin rather than via a shared package:
// the openclaw extensions boundary forbids cross-extension `src/` imports
// (`extensions/AGENTS.md`) and a single shared helper is also worth de-duping
// later, not pre-duping now.

const ALLOWLIST_PATH_PATTERN =
  /^(\/api\/v1\/workspaces\/[0-9a-f-]+\/.+|\/api\/v1\/openclaw\/[a-z]+\/[a-z0-9-/]+)(\?.*)?$/;
const DEFAULT_BFF_BASE_URL = "http://web_api.local";

export type BffFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * propfirm_manager BFF thread id for the CURRENT turn. When present it is
   * stamped as the `X-OpenClaw-Thread` request header so the BFF can identify
   * which sub-agent (specialist) is calling and enforce its granted authority.
   * Sourced from the plugin execute context (`context.threadId`), which the
   * SDK binds per turn from the session key.
   */
  threadId?: string;
};

export type BffError = {
  code: string;
  message: string;
  status: number;
  /**
   * The server's machine-readable "do this instead" hint, when it sent one.
   * Surfaced in the thrown Error's message so the MODEL can read it. A contract
   * mismatch the model cannot see is indistinguishable from a backend outage:
   * it retries the same wrong shape and finally reports the outage to the user.
   */
  retrySuggestion?: string;
};

/** Long bodies are truncated: this text ends up in a model prompt. */
const MAX_ERROR_BODY_CHARS = 2000;

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read the server's structured error envelope off a failed response.
 *
 * Previously this reported `response.statusText` and threw the BODY away, so a
 * 422 reached the model as the bare word "Unprocessable Entity" — the BFF's
 * `message` and `retry_suggestion`, which say exactly which key was wrong and
 * what to send instead, never arrived. That is the generator of an entire class
 * of silent contract drift.
 *
 * The BFF raises `{"detail": {"error": {code, message, retry_suggestion}}}`
 * (FastAPI wraps `HTTPException.detail`); FastAPI's own request-validation
 * failures use a list under `detail`. Every path here still yields a usable
 * detail — a body that cannot be read must never mask the HTTP failure itself.
 */
async function readBffErrorDetail(response: FetchResponse): Promise<BffError> {
  const fallback: BffError = {
    code: `bff_${response.status}`,
    message: response.statusText || `HTTP ${response.status}`,
    status: response.status,
  };

  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return fallback;
  }
  if (!raw) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  const root = asRecord(parsed);
  const detail = asRecord(root?.detail);
  // The envelope may sit under `detail.error`, under `detail`, or at the root.
  const envelope = [asRecord(detail?.error), detail, asRecord(root?.error), root].find(
    (candidate) => typeof candidate?.message === "string" && candidate.message.length > 0,
  );
  if (!envelope) {
    return { ...fallback, message: raw.slice(0, MAX_ERROR_BODY_CHARS) };
  }

  const code = envelope.code;
  const suggestion = envelope.retry_suggestion;
  return {
    code: typeof code === "string" && code.length > 0 ? code : fallback.code,
    message: String(envelope.message).slice(0, MAX_ERROR_BODY_CHARS),
    status: response.status,
    retrySuggestion:
      typeof suggestion === "string" && suggestion.length > 0
        ? suggestion.slice(0, MAX_ERROR_BODY_CHARS)
        : undefined,
  };
}

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
    // The retry suggestion belongs in the MESSAGE, not just the detail object:
    // the message is what the tool runner shows the model.
    const summary = `vctraderai bff request failed: ${detail.code} (${detail.status}) ${detail.message}`;
    super(
      detail.retrySuggestion ? `${summary} — retry_suggestion: ${detail.retrySuggestion}` : summary,
    );
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
  /**
   * Default per-turn BFF thread id bound at client-creation time. When set,
   * every request this client makes is stamped with `X-OpenClaw-Thread`
   * unless a per-call `options.threadId` overrides it. The plugin sources this
   * from its execute context (`context.threadId`).
   */
  threadId?: string;
};

export function createBffFetch(deps: BffClientDeps = {}): BffFetchFn {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const boundThreadId = deps.threadId;
  if (typeof fetchImpl !== "function") {
    throw new Error("vctraderai bff: global fetch is not available; Node >= 18 required");
  }
  return async function bffFetch(path: string, options: BffFetchOptions = {}): Promise<unknown> {
    assertAllowlistedPath(path);
    const baseUrl = readEnv("PFM_BFF_BASE_URL") ?? DEFAULT_BFF_BASE_URL;
    const token = readEnv("OPENCLAW_GATEWAY_TOKEN");
    const workspaceId = readEnv("PFM_AGENT_WORKSPACE_ID") ?? readEnv("PFM_WORKSPACE_ID");
    const queryString = buildQueryString(options.query);
    const url = `${baseUrl}${path}${queryString}`;
    const effectiveThreadId = options.threadId ?? boundThreadId;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : undefined),
      ...(workspaceId ? { "x-openclaw-workspace": workspaceId } : undefined),

      ...(effectiveThreadId ? { "x-openclaw-thread": effectiveThreadId } : undefined),
      ...options.headers,
    };
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new BffRequestError(await readBffErrorDetail(response));
    }
    return response.json();
  };
}

export const VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN = ALLOWLIST_PATH_PATTERN;
