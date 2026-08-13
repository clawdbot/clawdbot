// Shared ClawHub URL, authentication, and bounded HTTP client.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { retryClawHubRead } from "./clawhub-retry.js";
import { isTruthyEnvValue } from "./env.js";
import { readResponseTextSnippet, readResponseWithLimit } from "./http-body.js";

const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const CLAWHUB_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const CLAWHUB_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CLAWHUB_ERROR_BODY_MAX_BYTES = 8 * 1024;
const CLAWHUB_ERROR_BODY_MAX_CHARS = 400;

export type ClawHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ClawHubRequestParams = {
  baseUrl?: string;
  path?: string;
  url?: string;
  method?: "GET" | "POST";
  json?: unknown;
  token?: string;
  timeoutMs?: number;
  search?: Record<string, string | undefined>;
  fetchImpl?: ClawHubFetch;
  skipAuth?: boolean;
  retryTransientReads?: boolean;
  headers?: Record<string, string>;
};

type ClawHubConfigLike = {
  token?: unknown;
  accessToken?: unknown;
  authToken?: unknown;
  apiToken?: unknown;
  auth?: ClawHubConfigLike | null;
  session?: ClawHubConfigLike | null;
  credentials?: ClawHubConfigLike | null;
  user?: ClawHubConfigLike | null;
};

function resolveClawHubRequestTimeoutMs(timeoutMs: unknown): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
}

export class ClawHubRequestError extends Error {
  readonly status: number;
  readonly requestPath: string;
  readonly responseBody: string;

  constructor(params: { path: string; status: number; body: string }) {
    super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "ClawHubRequestError";
    this.status = params.status;
    this.requestPath = params.path;
    this.responseBody = params.body;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  const envValue =
    normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_URL) ||
    normalizeOptionalString(process.env.CLAWHUB_URL) ||
    DEFAULT_CLAWHUB_URL;
  const value = (normalizeOptionalString(baseUrl) || envValue).replace(/\/+$/, "");
  return value || DEFAULT_CLAWHUB_URL;
}

export function resolveClawHubImageUrl(value: string | null | undefined, baseUrl?: string) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const registryUrl = new URL(`${normalizeBaseUrl(baseUrl)}/`);
    const url = new URL(normalized, registryUrl);
    if (
      url.origin !== registryUrl.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/v1\/skill-icons\/[a-f\d]{64}$/u.test(url.pathname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function extractTokenFromClawHubConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as ClawHubConfigLike;
  return (
    normalizeOptionalString(record.accessToken) ??
    normalizeOptionalString(record.authToken) ??
    normalizeOptionalString(record.apiToken) ??
    normalizeOptionalString(record.token) ??
    extractTokenFromClawHubConfig(record.auth) ??
    extractTokenFromClawHubConfig(record.session) ??
    extractTokenFromClawHubConfig(record.credentials) ??
    extractTokenFromClawHubConfig(record.user)
  );
}

function resolveClawHubConfigPaths(): string[] {
  const explicit =
    normalizeOptionalString(process.env.CLAWHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.CLAWDHUB_CONFIG_PATH); // legacy misspelling from older clawhub CLI builds; keep for back-compat
  if (explicit) {
    return [explicit];
  }

  const xdgConfigHome = normalizeOptionalString(process.env.XDG_CONFIG_HOME);
  const configHome =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
  const xdgPath = path.join(configHome, "clawhub", "config.json");

  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "clawhub", "config.json"),
      xdgPath,
    ];
  }

  return [xdgPath];
}

export async function resolveClawHubAuthToken(): Promise<string | undefined> {
  const envToken =
    normalizeOptionalString(process.env.CLAWHUB_TOKEN) ||
    normalizeOptionalString(process.env.CLAWHUB_AUTH_TOKEN);
  if (envToken) {
    return envToken;
  }

  for (const configPath of resolveClawHubConfigPaths()) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const token = extractTokenFromClawHubConfig(JSON.parse(raw));
      if (token) {
        return token;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined;
}

function buildUrl(params: Pick<ClawHubRequestParams, "baseUrl" | "path" | "search" | "url">): URL {
  if (params.url) {
    const url = new URL(params.url, `${normalizeBaseUrl(params.baseUrl)}/`);
    for (const [key, value] of Object.entries(params.search ?? {})) {
      if (!value) {
        continue;
      }
      url.searchParams.set(key, value);
    }
    return url;
  }
  if (!params.path) {
    throw new Error("ClawHub request path is required");
  }
  const url = new URL(`${normalizeBaseUrl(params.baseUrl)}/`);
  const basePath = url.pathname.replace(/\/+$/, "");
  const requestPath = params.path.startsWith("/") ? params.path : `/${params.path}`;
  url.pathname = `${basePath}${requestPath}`;
  for (const [key, value] of Object.entries(params.search ?? {})) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url;
}

export async function requestClawHub(
  params: ClawHubRequestParams,
): Promise<{ response: Response; url: URL; hasToken: boolean }> {
  const url = buildUrl(params);
  const token = params.skipAuth
    ? undefined
    : normalizeOptionalString(params.token) || (await resolveClawHubAuthToken());
  const timeoutMs = resolveClawHubRequestTimeoutMs(params.timeoutMs);
  const request = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`ClawHub request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(params.json === undefined ? {} : { "Content-Type": "application/json" }),
      ...params.headers,
    };
    const init: RequestInit = { signal: controller.signal };
    if (params.method) {
      init.method = params.method;
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    if (params.json !== undefined) {
      init.body = JSON.stringify(params.json);
    }
    try {
      const response = await (params.fetchImpl ?? fetch)(url, init);
      return { response, url, hasToken: Boolean(token) };
    } finally {
      clearTimeout(timeout);
    }
  };

  // A write may have committed before its response failed, so only replay
  // idempotent reads across transient ClawHub transport failures.
  if ((params.method ?? "GET") !== "GET" || params.retryTransientReads === false) {
    return await request();
  }
  return await retryClawHubRead(request, {
    disposeRetry: async ({ response }) => {
      await response.body?.cancel().catch(() => undefined);
    },
  });
}

async function readErrorBody(response: Response, timeoutMs?: number): Promise<string> {
  try {
    const snippet = await readResponseTextSnippet(response, {
      maxBytes: CLAWHUB_ERROR_BODY_MAX_BYTES,
      maxChars: CLAWHUB_ERROR_BODY_MAX_CHARS,
      chunkTimeoutMs: resolveClawHubRequestTimeoutMs(timeoutMs),
    });
    return snippet || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

export async function createClawHubError(
  response: Response,
  url: URL,
  hasToken: boolean,
  timeoutMs?: number,
): Promise<ClawHubRequestError> {
  let body = await readErrorBody(response, timeoutMs);
  if (response.status === 429) {
    const suffix = formatRateLimitSuffix(response.headers, hasToken);
    if (suffix) {
      body = `${body} ${suffix}`;
    }
  }
  return new ClawHubRequestError({
    path: url.pathname,
    status: response.status,
    body,
  });
}

function formatRateLimitSuffix(headers: Headers, hasToken: boolean): string {
  const resetSeconds =
    parseRateLimitDeltaSeconds(headers.get("RateLimit-Reset")) ??
    parseRateLimitDeltaSeconds(headers.get("Retry-After"));
  const segments: string[] = [];
  if (resetSeconds !== undefined) {
    segments.push(`(resets in ${resetSeconds}s)`);
  }
  if (!hasToken) {
    segments.push("Sign in for higher rate limits.");
  }
  return segments.join(" ");
}

function parseRateLimitDeltaSeconds(value: string | null): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }
  return parseStrictNonNegativeInteger(normalized);
}

// Successful ClawHub payloads must reject malformed UTF-8 so replacement
// characters never pass validation or enter persistent caches.
export function decodeClawHubResponseBody(buffer: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

export async function fetchClawHubJson<T>(params: ClawHubRequestParams): Promise<T> {
  const { response, url, hasToken } = await requestClawHub(params);
  if (!response.ok) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
  return parseClawHubJsonBody<T>(response, url, params.timeoutMs);
}

export async function parseClawHubJsonBody<T>(
  response: Response,
  url: URL,
  timeoutMs?: number,
): Promise<T> {
  const buffer = await readResponseWithLimit(response, CLAWHUB_JSON_MAX_BYTES, {
    chunkTimeoutMs: resolveClawHubRequestTimeoutMs(timeoutMs),
    onOverflow: ({ size, maxBytes }) =>
      new Error(
        `ClawHub ${url.pathname} response exceeded ${maxBytes} bytes (${size} bytes received)`,
      ),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`ClawHub ${url.pathname} response stalled after ${chunkTimeoutMs}ms`),
  });
  try {
    return JSON.parse(decodeClawHubResponseBody(buffer)) as T;
  } catch (cause) {
    throw new Error(`ClawHub ${url.pathname} returned malformed JSON`, { cause });
  }
}

export async function readClawHubBytes(params: {
  response: Response;
  maxBytes?: number;
  timeoutMs?: number;
  resourceLabel: string;
}): Promise<Uint8Array> {
  const timeoutMs = resolveClawHubRequestTimeoutMs(params.timeoutMs);
  const maxBytes = params.maxBytes ?? CLAWHUB_ARCHIVE_MAX_BYTES;
  const contentEncoding = normalizeOptionalString(params.response.headers.get("content-encoding"));
  const declaredSize =
    !contentEncoding || contentEncoding.toLowerCase() === "identity"
      ? parseStrictNonNegativeInteger(params.response.headers.get("content-length"))
      : undefined;
  if (declaredSize !== undefined && declaredSize > maxBytes) {
    // Fetch may decode encoded bodies while retaining their wire length, so
    // only identity lengths can safely short-circuit the decoded stream cap.
    await params.response.body?.cancel().catch(() => undefined);
    throw createClawHubBodyLimitError(params.resourceLabel, declaredSize, maxBytes, "declared");
  }
  return await readResponseWithLimit(params.response, maxBytes, {
    chunkTimeoutMs: timeoutMs,
    onOverflow: ({ size, maxBytes: limitBytes }) =>
      createClawHubBodyLimitError(params.resourceLabel, size, limitBytes),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`ClawHub ${params.resourceLabel} body stalled after ${chunkTimeoutMs}ms`),
  });
}

function createClawHubBodyLimitError(
  resourceLabel: string,
  size: number,
  maxBytes: number,
  measurement: "declared" | "received" = "received",
): Error {
  return new Error(
    `ClawHub ${resourceLabel} exceeded ${maxBytes} bytes (${size} bytes ${measurement})`,
  );
}

export function readClawHubStringField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string | null | undefined {
  const value = source[field];
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a string or null.`);
}

export function readRequiredClawHubBooleanField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  const value = source[field];
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a boolean.`);
}

export function readRequiredClawHubStringArrayField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string[] {
  const value = source[field];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a string array.`);
}

export function readRequiredClawHubStringField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a non-empty string.`);
}

export function readRequiredClawHubNumberField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = source[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a number.`);
}

export function readClawHubBooleanField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean | undefined {
  const value = source[field];
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a boolean.`);
}

export function readClawHubStringArrayField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string[] | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a string array.`);
}

/** Resolves the configured ClawHub base URL, falling back to the default public host. */
export function resolveClawHubBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function isDefaultClawHubBaseUrl(baseUrl?: string): boolean {
  return normalizeBaseUrl(baseUrl) === normalizeBaseUrl(DEFAULT_CLAWHUB_URL);
}

export function isClawHubTelemetryDisabled(): boolean {
  const raw =
    normalizeOptionalString(process.env.CLAWHUB_DISABLE_TELEMETRY) ??
    normalizeOptionalString(process.env.CLAWDHUB_DISABLE_TELEMETRY);
  if (!raw) {
    return false;
  }
  return isTruthyEnvValue(raw);
}
