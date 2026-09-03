import { createHash } from "node:crypto";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { parseRetryAfterHeaderSeconds } from "../infra/retry-after.js";
import {
  assertSecretOwnerAvailable,
  isTrustedSecretSurfaceUnavailableError,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE =
  "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.";
const GITHUB_JSON_MAX_BYTES = 256 * 1024;
export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_MAX_REDIRECTS = 3;

export class ControlUiGitHubError extends Error {
  private readonly retryAtMs?: number;
  readonly upstreamStatus: number;

  // Messages are authored here or by the metadata parser, never upstream bodies.
  constructor(
    readonly statusCode: number,
    message: string,
    options: { retryAtMs?: number; upstreamStatus?: number } = {},
  ) {
    super(message);
    this.name = "ControlUiGitHubError";
    this.upstreamStatus = options.upstreamStatus ?? statusCode;
    this.retryAtMs = options.retryAtMs;
  }

  get retryAfterMs(): number | undefined {
    // Cached failures must keep the original reset time when a hovercard reopens.
    return this.retryAtMs === undefined ? undefined : Math.max(0, this.retryAtMs - Date.now());
  }
}

// Keep no-response transport failures distinct from HTTP/protocol failures:
// identity synchronization may reuse an exact verified cache only for the former.
class ControlUiGitHubTransportError extends Error {}

export function formatControlUiGitHubPreviewError(error: unknown): {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (isTrustedSecretSurfaceUnavailableError(error)) {
    return { message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE, retryable: false };
  }
  if (error instanceof ControlUiGitHubTransportError) {
    return { message: `${error.message}. Retry or check GitHub availability.`, retryable: true };
  }
  if (error instanceof ControlUiGitHubError) {
    const status = `HTTP ${error.upstreamStatus}`;
    switch (error.statusCode) {
      case 401:
        return {
          message: `GitHub authentication failed (${status}). Reconnect the GitHub identity in Settings.`,
          retryable: false,
        };
      case 403:
        return {
          message: `GitHub access denied (${status}). Check the configured GitHub identity's repository access.`,
          retryable: false,
        };
      case 404:
        // The shared server credential must not reveal whether a private repository exists.
        return {
          message:
            "GitHub item is unavailable or not public (HTTP 404). Open the link on GitHub to check access.",
          retryable: false,
        };
      case 429: {
        const retryAfterMs = error.retryAfterMs;
        const wait =
          retryAfterMs === undefined ? "Wait" : `Wait ${Math.ceil(retryAfterMs / 1_000)} seconds`;
        return {
          message: `GitHub API rate limit exceeded (${status}). ${wait} and retry.`,
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      case 502:
        return {
          message: `${error.message.slice(0, 256)}. Retry or check GitHub availability.`,
          retryable: true,
        };
    }
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { message: "GitHub request timed out. Retry shortly.", retryable: true };
  }
  // Credential subprocess errors and arbitrary transport diagnostics can contain secrets.
  return {
    message: "GitHub preview could not be loaded. Retry or check the server logs.",
    retryable: false,
  };
}

export function githubApiToken(
  env: NodeJS.ProcessEnv = process.env,
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
): string | undefined {
  const configured = config?.gateway?.controlUi?.github?.token;
  if (configured !== undefined) {
    assertSecretOwnerAvailable("capability", "control-ui-github");
    const token = typeof configured === "string" ? configured.trim() : "";
    if (!token) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not materialized by the active runtime",
      });
    }
    return token;
  }
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined;
}

/** Raw-config inspection for doctor; it never consults process-global runtime degradation state. */
export function hasConfiguredGitHubApiCredential(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): boolean {
  return (
    config.gateway?.controlUi?.github?.token !== undefined ||
    Boolean(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim())
  );
}

/** Captures the effective token and a non-secret cache scope from the same env snapshot. */
export function resolveGitHubApiCredentialScope(env: NodeJS.ProcessEnv = process.env): {
  token: string | undefined;
  cacheScope: string;
} {
  const token = githubApiToken(env);
  return {
    token,
    cacheScope: token ? createHash("sha256").update(token).digest("hex") : "anonymous",
  };
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw-Control-UI",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isGitHubApiRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeGitHubApiUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base);
    if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password || url.port) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export async function fetchGitHubApi(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  beforeRedirect?: (url: URL) => Promise<void>,
  identity?: { revalidate: () => Promise<void>; assertSelected: () => void },
): Promise<Response> {
  const initialUrl = safeGitHubApiUrl(rawUrl);
  if (!initialUrl) {
    throw new ControlUiGitHubError(502, "Invalid GitHub API URL");
  }
  let url: URL = initialUrl;

  const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  for (let redirects = 0; ; redirects += 1) {
    // Recheck every dispatch, including redirects and auxiliary metadata reads.
    // Selection must still be current after the asynchronous credential read.
    if (identity) {
      await identity.revalidate();
      identity.assertSelected();
    }
    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        headers: githubApiHeaders(token),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      throw new ControlUiGitHubTransportError(
        timedOut ? "GitHub request timed out" : "Could not reach GitHub",
      );
    }
    if (!isGitHubApiRedirect(response.status)) {
      return response;
    }

    const location: string | null = response.headers.get("location");
    const nextUrl: URL | null = location ? safeGitHubApiUrl(location, url) : null;
    if (!nextUrl || redirects >= GITHUB_API_MAX_REDIRECTS) {
      await discardResponse(response);
      throw new ControlUiGitHubError(502, "GitHub API returned an unsafe redirect");
    }
    // Credentials stay on the fixed API origin across GitHub redirects;
    // callers still verify the final response repository before returning it.
    await discardResponse(response);
    await beforeRedirect?.(nextUrl);
    url = nextUrl;
  }
}

export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: () => new ControlUiGitHubError(502, "GitHub response exceeded the size limit"),
    });
  } finally {
    await discardResponse(response);
  }
}

// GitHub reports quota exhaustion as 429 or as 403 with exhausted-quota
// headers; a bare 403 is a permission response and must stay distinguishable
// so callers can degrade optional fetches instead of flagging rate limits.
function isGitHubRateLimitResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))
  );
}

function githubResponseErrorStatus(response: Response): number {
  if (isGitHubRateLimitResponse(response)) {
    return 429;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return response.status;
  }
  return 502;
}

// Optional host auth raises quota and unlocks private-repo reads, but an
// unusable credential must not disable public GitHub data that works anonymously.
export async function withOptionalGitHubAuth<T>(
  token: string | undefined,
  request: (token: string | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await request(token);
  } catch (error) {
    const status = error instanceof ControlUiGitHubError ? error.statusCode : 0;
    if (token && [401, 403, 429].includes(status)) {
      return request(undefined);
    }
    throw error;
  }
}

export async function readGitHubJsonResponse(
  response: Response,
  maxBytes = GITHUB_JSON_MAX_BYTES,
): Promise<unknown> {
  if (!response.ok) {
    const status = githubResponseErrorStatus(response);
    let retryAtMs: number | undefined;
    if (status === 429) {
      const retrySeconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
      const reset = parseStrictNonNegativeInteger(response.headers.get("x-ratelimit-reset"));
      if (retrySeconds !== undefined) {
        retryAtMs = Date.now() + retrySeconds * 1_000;
      } else if (reset !== undefined && reset <= Number.MAX_SAFE_INTEGER / 1_000) {
        retryAtMs = reset * 1_000;
      }
    }
    await discardResponse(response);
    throw new ControlUiGitHubError(status, `GitHub request failed (HTTP ${response.status})`, {
      upstreamStatus: response.status,
      retryAtMs,
    });
  }
  const body = await readBoundedResponse(response, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubError(502, "GitHub response was not valid JSON");
  }
}

/** Fetch a GitHub API JSON document with bounded size and normalized errors. */
export function fetchGitHubJson(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<unknown> {
  return withOptionalGitHubAuth(token, async (requestToken) =>
    readGitHubJsonResponse(await fetchGitHubApi(rawUrl, fetchImpl, requestToken)),
  );
}
