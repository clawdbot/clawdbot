import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readResponseWithLimit } from "../infra/http-body.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

const GITHUB_OAUTH_CLIENT_ID = "Ov23liUjOXHi28w2fDlH";
const GITHUB_OAUTH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_OAUTH_VERIFICATION_URL = "https://github.com/login/device";

// Request repository/workflow publication and the existing device-flow scopes.
const GITHUB_OAUTH_SCOPE = "repo workflow read:org gist offline_access";
const GITHUB_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_OAUTH_RESPONSE_MAX_BYTES = 16 * 1024;
const GITHUB_OAUTH_STRING_MAX_CHARS = 2 * 1024;
const GITHUB_OAUTH_SCOPE_MAX_CHARS = 4 * 1024;
const GITHUB_OAUTH_SCOPE_MAX_COUNT = 32;
const GITHUB_OAUTH_SCOPE_MAX_LENGTH = 64;
const GITHUB_OAUTH_ERROR_TEXT_MAX_CHARS = 2 * 1024;
const GITHUB_OAUTH_MAX_DURATION_SECONDS = 366 * 24 * 60 * 60;
const GITHUB_OAUTH_MAX_INTERVAL_SECONDS = 60 * 60;

type GitHubOAuthRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type GitHubOAuthDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: typeof GITHUB_OAUTH_VERIFICATION_URL;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type GitHubOAuthTokenPair = {
  accessToken: string;
  tokenType: "bearer";
  scopes: string[];
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
};

type GitHubOAuthErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "unsupported_grant_type"
  | "incorrect_client_credentials"
  | "incorrect_device_code"
  | "bad_verification_code"
  | "access_denied"
  | "device_flow_disabled"
  | "unverified_user_email"
  | "bad_refresh_token";

type GitHubOAuthErrorDetails = {
  errorDescription?: string;
  errorUri?: string;
};

type GitHubOAuthDevicePollResult =
  | { status: "authorized"; tokens: GitHubOAuthTokenPair }
  | ({ status: "authorization_pending" } & GitHubOAuthErrorDetails)
  | ({ status: "slow_down"; intervalSeconds?: number } & GitHubOAuthErrorDetails)
  | ({ status: "expired_token" } & GitHubOAuthErrorDetails)
  | ({ status: "access_denied" } & GitHubOAuthErrorDetails)
  | ({
      status: "error";
      code: Exclude<
        GitHubOAuthErrorCode,
        "authorization_pending" | "slow_down" | "expired_token" | "access_denied"
      >;
    } & GitHubOAuthErrorDetails);

type GitHubOAuthRefreshResult =
  | { status: "refreshed"; tokens: GitHubOAuthTokenPair }
  | ({ status: "error"; code: GitHubOAuthErrorCode } & GitHubOAuthErrorDetails);

function githubOAuthProtocolError(surface: string): Error {
  return new Error(`GitHub OAuth ${surface} response was invalid`);
}

function readBoundedString(
  value: unknown,
  surface: string,
  maxChars = GITHUB_OAUTH_STRING_MAX_CHARS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    value.trim() !== value
  ) {
    throw githubOAuthProtocolError(surface);
  }
  return value;
}

function readOptionalBoundedString(
  value: unknown,
  surface: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readBoundedString(value, surface, maxChars);
}

function readPositiveInteger(value: unknown, surface: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw githubOAuthProtocolError(surface);
  }
  return value;
}

function readOptionalErrorUri(value: unknown, surface: string): string | undefined {
  const raw = readOptionalBoundedString(value, surface, GITHUB_OAUTH_ERROR_TEXT_MAX_CHARS);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw githubOAuthProtocolError(surface);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw githubOAuthProtocolError(surface);
  }
  return raw;
}

function normalizeGitHubScopes(value: unknown, surface: string): string[] {
  if (typeof value !== "string" || value.length > GITHUB_OAUTH_SCOPE_MAX_CHARS) {
    throw githubOAuthProtocolError(surface);
  }
  const scopes = value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((scope) => {
      if (scope.length > GITHUB_OAUTH_SCOPE_MAX_LENGTH || !/^[a-z0-9:_-]+$/u.test(scope)) {
        throw githubOAuthProtocolError(surface);
      }
      return scope;
    });
  const normalized = [...new Set(scopes)].toSorted();
  if (normalized.length > GITHUB_OAUTH_SCOPE_MAX_COUNT) {
    throw githubOAuthProtocolError(surface);
  }
  return normalized;
}

function parseGitHubOAuthTokenPair(
  record: Record<string, unknown>,
  surface: string,
): GitHubOAuthTokenPair {
  if (record.token_type !== "bearer") {
    throw githubOAuthProtocolError(surface);
  }
  const scopes = normalizeGitHubScopes(record.scope, surface);
  if (
    !scopes.includes("repo") ||
    !scopes.includes("workflow") ||
    !scopes.includes("read:org") ||
    !scopes.includes("gist")
  ) {
    throw githubOAuthProtocolError(surface);
  }
  const accessToken = readBoundedString(record.access_token, surface);
  const refreshToken = readBoundedString(record.refresh_token, surface);
  registerSecretValueForRedaction(accessToken);
  registerSecretValueForRedaction(refreshToken);
  return {
    accessToken,
    tokenType: "bearer",
    scopes,
    expiresInSeconds: readPositiveInteger(
      record.expires_in,
      surface,
      GITHUB_OAUTH_MAX_DURATION_SECONDS,
    ),
    refreshToken,
    refreshTokenExpiresInSeconds: readPositiveInteger(
      record.refresh_token_expires_in,
      surface,
      GITHUB_OAUTH_MAX_DURATION_SECONDS,
    ),
  };
}

const GITHUB_OAUTH_ERROR_CODES = new Set<string>([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "bad_verification_code",
  "access_denied",
  "device_flow_disabled",
  "unverified_user_email",
  "bad_refresh_token",
]);

function isGitHubOAuthErrorCode(value: unknown): value is GitHubOAuthErrorCode {
  return typeof value === "string" && GITHUB_OAUTH_ERROR_CODES.has(value);
}

function parseGitHubOAuthError(
  record: Record<string, unknown>,
  surface: string,
): { code: GitHubOAuthErrorCode; intervalSeconds?: number } & GitHubOAuthErrorDetails {
  const code = record.error;
  if (!isGitHubOAuthErrorCode(code)) {
    throw githubOAuthProtocolError(surface);
  }
  const intervalSeconds =
    record.interval === undefined
      ? undefined
      : readPositiveInteger(record.interval, surface, GITHUB_OAUTH_MAX_INTERVAL_SECONDS);
  const errorDescription = readOptionalBoundedString(
    record.error_description,
    surface,
    GITHUB_OAUTH_ERROR_TEXT_MAX_CHARS,
  );
  const errorUri = readOptionalErrorUri(record.error_uri, surface);
  return {
    code,
    ...(errorDescription !== undefined ? { errorDescription } : {}),
    ...(errorUri !== undefined ? { errorUri } : {}),
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
  };
}

function parseJsonObject(bytes: Buffer, surface: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw githubOAuthProtocolError(surface);
  }
  const record = asOptionalRecord(parsed);
  if (!record) {
    throw githubOAuthProtocolError(surface);
  }
  return record;
}

async function postGitHubOAuthForm(
  url: typeof GITHUB_OAUTH_DEVICE_CODE_URL | typeof GITHUB_OAUTH_ACCESS_TOKEN_URL,
  form: URLSearchParams,
  surface: string,
  options: GitHubOAuthRequestOptions,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, GITHUB_OAUTH_REQUEST_TIMEOUT_MS, 1);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal,
  });
  return { response, body: await readGitHubResponse(response, surface, timeoutMs) };
}

async function readGitHubResponse(response: Response, surface: string, timeoutMs: number) {
  const bytes = await readResponseWithLimit(response, GITHUB_OAUTH_RESPONSE_MAX_BYTES, {
    chunkTimeoutMs: timeoutMs,
    timeoutMs,
    onOverflow: () => githubOAuthProtocolError(surface),
    onIdleTimeout: () => githubOAuthProtocolError(surface),
    onTimeout: () => githubOAuthProtocolError(surface),
  });
  return parseJsonObject(bytes, surface);
}

/** Verifies only the supplied credential at GitHub's fixed account endpoint. */
export async function verifyGitHubCredential(
  token: string,
  options: GitHubOAuthRequestOptions = {},
): Promise<
  | { status: "available"; account: GitHubToolAccount; scopes: string[] }
  | { status: "unavailable" | "rate_limited" | "unverified" }
> {
  registerSecretValueForRedaction(token);
  try {
    readBoundedString(token, "account");
    if (/\s/u.test(token)) {
      return { status: "unavailable" };
    }
    const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, GITHUB_OAUTH_REQUEST_TIMEOUT_MS, 1);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch("https://api.github.com/user", {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")));
      return {
        status:
          response.status === 401 ? "unavailable" : rateLimited ? "rate_limited" : "unverified",
      };
    }
    const body = await readGitHubResponse(response, "account", timeoutMs);
    const accountId = readPositiveInteger(body.id, "account", Number.MAX_SAFE_INTEGER);
    const login = readBoundedString(body.login, "account", 100);
    const avatarUrl =
      body.avatar_url == null ? null : readBoundedString(body.avatar_url, "account");
    const scopes = normalizeGitHubScopes(response.headers.get("x-oauth-scopes") ?? "", "account");
    return { status: "available", account: { accountId, login, avatarUrl }, scopes };
  } catch {
    // Network errors, response bodies, and abort reasons can contain credentials.
    return { status: "unverified" };
  }
}

function throwGitHubOAuthHttpError(response: Response, surface: string): never {
  throw new Error(`GitHub OAuth ${surface} request failed (HTTP ${response.status})`);
}

export async function requestGitHubOAuthDeviceCode(
  options: GitHubOAuthRequestOptions = {},
): Promise<GitHubOAuthDeviceAuthorization> {
  const { response, body } = await postGitHubOAuthForm(
    GITHUB_OAUTH_DEVICE_CODE_URL,
    new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      scope: GITHUB_OAUTH_SCOPE,
    }),
    "device authorization",
    options,
  );
  if (!response.ok) {
    throwGitHubOAuthHttpError(response, "device authorization");
  }
  const deviceCode = readBoundedString(body.device_code, "device authorization");
  const userCode = readBoundedString(body.user_code, "device authorization", 64);
  if (!/^[A-Za-z0-9_-]{40}$/u.test(deviceCode) || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(userCode)) {
    throw githubOAuthProtocolError("device authorization");
  }
  if (body.verification_uri !== GITHUB_OAUTH_VERIFICATION_URL) {
    throw githubOAuthProtocolError("device authorization");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: GITHUB_OAUTH_VERIFICATION_URL,
    expiresInSeconds: readPositiveInteger(
      body.expires_in,
      "device authorization",
      GITHUB_OAUTH_MAX_DURATION_SECONDS,
    ),
    intervalSeconds: readPositiveInteger(
      body.interval,
      "device authorization",
      GITHUB_OAUTH_MAX_INTERVAL_SECONDS,
    ),
  };
}

// Each call performs one poll. The lifecycle owner schedules the next attempt and
// applies GitHub's cumulative slow_down floor using the returned interval.
export async function pollGitHubOAuthDeviceToken(
  params: GitHubOAuthRequestOptions & { deviceCode: string },
): Promise<GitHubOAuthDevicePollResult> {
  const deviceCode = readBoundedString(params.deviceCode, "device token");
  if (!/^[A-Za-z0-9_-]{40}$/u.test(deviceCode)) {
    throw githubOAuthProtocolError("device token");
  }
  const { response, body } = await postGitHubOAuthForm(
    GITHUB_OAUTH_ACCESS_TOKEN_URL,
    new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    "device token",
    params,
  );
  if (body.error !== undefined && body.access_token !== undefined) {
    throw githubOAuthProtocolError("device token");
  }
  if (body.error !== undefined) {
    const { code, intervalSeconds, ...details } = parseGitHubOAuthError(body, "device token");
    switch (code) {
      case "authorization_pending":
        return { status: code, ...details };
      case "slow_down":
        return {
          status: code,
          ...details,
          ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
        };
      case "expired_token":
      case "access_denied":
        return { status: code, ...details };
      default:
        return { status: "error", code, ...details };
    }
  }
  if (!response.ok) {
    throwGitHubOAuthHttpError(response, "device token");
  }
  return {
    status: "authorized",
    tokens: parseGitHubOAuthTokenPair(body, "device token"),
  };
}

export async function refreshGitHubOAuthToken(
  params: GitHubOAuthRequestOptions & { refreshToken: string },
): Promise<GitHubOAuthRefreshResult> {
  const refreshToken = readBoundedString(params.refreshToken, "token refresh");
  // Device-flow refresh is a public-client exchange. Sending a bundled client
  // secret would not make it confidential and is not required by GitHub.
  const { response, body } = await postGitHubOAuthForm(
    GITHUB_OAUTH_ACCESS_TOKEN_URL,
    new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    "token refresh",
    params,
  );
  if (body.error !== undefined && body.access_token !== undefined) {
    throw githubOAuthProtocolError("token refresh");
  }
  if (body.error !== undefined) {
    const { code, errorDescription, errorUri } = parseGitHubOAuthError(body, "token refresh");
    return {
      status: "error",
      code,
      ...(errorDescription !== undefined ? { errorDescription } : {}),
      ...(errorUri !== undefined ? { errorUri } : {}),
    };
  }
  if (!response.ok) {
    throwGitHubOAuthHttpError(response, "token refresh");
  }
  return {
    status: "refreshed",
    tokens: parseGitHubOAuthTokenPair(body, "token refresh"),
  };
}
