// Shared api.github.com plumbing for Control UI GitHub surfaces (link
// previews, session pull request chips): pinned origin, manual redirects,
// bounded bodies, and normalized upstream error statuses.
import { readResponseWithLimit } from "../infra/http-body.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_JSON_MAX_BYTES = 256 * 1024;
export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_MAX_REDIRECTS = 3;

export class ControlUiGitHubError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ControlUiGitHubError";
    this.statusCode = statusCode;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlUiGitHubError(502, `GitHub response omitted ${key}`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function githubApiToken(): string | undefined {
  return process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
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
): Promise<Response> {
  const initialUrl = safeGitHubApiUrl(rawUrl);
  if (!initialUrl) {
    throw new ControlUiGitHubError(502, "Invalid GitHub API URL");
  }
  let url: URL = initialUrl;

  const signal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  for (let redirects = 0; ; redirects += 1) {
    const response: Response = await fetchImpl(url.href, {
      headers: githubApiHeaders(token),
      redirect: "manual",
      signal,
    });
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
    return await readResponseWithLimit(response, maxBytes);
  } finally {
    await discardResponse(response);
  }
}

export function upstreamErrorStatus(status: number): number {
  if (status === 404) {
    return 404;
  }
  if (status === 403 || status === 429) {
    return 429;
  }
  return 502;
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

function jsonErrorStatus(response: Response): number {
  if (isGitHubRateLimitResponse(response)) {
    return 429;
  }
  if (response.status === 404 || response.status === 403) {
    return response.status;
  }
  return 502;
}

/** Fetch a GitHub API JSON document with bounded size and normalized errors. */
export async function fetchGitHubJson(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<unknown> {
  const response = await fetchGitHubApi(rawUrl, fetchImpl, token);
  if (!response.ok) {
    const status = jsonErrorStatus(response);
    await discardResponse(response);
    throw new ControlUiGitHubError(status, `GitHub request failed (${response.status})`);
  }
  const body = await readBoundedResponse(response, GITHUB_JSON_MAX_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubError(502, "GitHub response was not valid JSON");
  }
}
