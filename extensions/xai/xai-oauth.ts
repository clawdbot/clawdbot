// Xai plugin module implements xai oauth behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  toFormUrlEncoded,
  type OAuthCredential,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { xaiUserAgent } from "./src/xai-user-agent.js";

const PROVIDER_ID = "xai";
const XAI_OAUTH_METHOD_ID = "oauth";
const XAI_OAUTH_CHOICE_ID = "xai-oauth";
const XAI_DEVICE_CODE_METHOD_ID = "device-code";
const XAI_DEVICE_CODE_CHOICE_ID = "xai-device-code";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_LEGACY_OAUTH_TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth/token`;

const XAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const XAI_OAUTH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const XAI_OAUTH_REFRESH_MAX_ATTEMPTS = 3;
const XAI_OAUTH_REFRESH_RETRY_DELAY_MS = 250;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5 * 1000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1 * 1000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5 * 1000;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type XaiOAuthDiscovery = {
  tokenEndpoint: string;
};

type XaiDeviceCodeDiscovery = {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
};

type XaiOAuthTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expires?: number;
  idToken?: string;
};

type XaiOAuthIdentity = {
  email?: string;
  displayName?: string;
  accountId?: string;
};

type XaiOAuthFetchOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
};

function xaiOAuthFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type XaiDeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInMs: number;
  intervalMs: number;
};

type XaiOAuthErrorResponse = {
  error?: string;
  errorDescription?: string;
};

type XaiOAuthResponseBody = {
  json: unknown;
  text: string;
};

function getFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return false;
    }
    return url.hostname === "x.ai" || url.hostname.endsWith(".x.ai");
  } catch {
    return false;
  }
}

function requireTrustedXaiOAuthEndpoint(endpoint: string, label: string): string {
  if (!isTrustedXaiOAuthEndpoint(endpoint)) {
    throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return endpoint;
}

function readStringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readResponseBody(response: Response): Promise<XaiOAuthResponseBody> {
  const buffer = await readResponseWithLimit(response, XAI_OAUTH_RESPONSE_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`xAI OAuth response exceeds ${maxBytes} bytes`),
  });
  const text = new TextDecoder().decode(buffer);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { json, text };
}

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
  const body = await readResponseBody(response);
  if (!response.ok) {
    const errorText =
      readStringRecord(body.json).error_description ?? readStringRecord(body.json).error;
    throw new Error(
      `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
    );
  }
  return body.json;
}

async function fetchXaiOAuthDiscoveryDocument(
  options: XaiOAuthFetchOptions = {},
): Promise<Record<string, unknown>> {
  const response = await getFetchImpl(options.fetchImpl)(XAI_OAUTH_DISCOVERY_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": xaiUserAgent(),
    },
    signal: xaiOAuthFetchSignal(options.signal),
  });
  return readStringRecord(await readJsonResponse(response, "xAI OAuth discovery"));
}

async function fetchXaiOAuthDiscovery(
  options: XaiOAuthFetchOptions = {},
): Promise<XaiOAuthDiscovery> {
  const json = await fetchXaiOAuthDiscoveryDocument(options);
  const tokenEndpoint = json.token_endpoint;
  if (typeof tokenEndpoint !== "string") {
    throw new Error("xAI OAuth discovery response is missing the token endpoint");
  }
  return {
    tokenEndpoint: requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint"),
  };
}

async function fetchXaiDeviceCodeDiscovery(
  options: XaiOAuthFetchOptions = {},
): Promise<XaiDeviceCodeDiscovery> {
  const json = await fetchXaiOAuthDiscoveryDocument(options);
  const deviceAuthorizationEndpoint = json.device_authorization_endpoint;
  const tokenEndpoint = json.token_endpoint;
  if (typeof deviceAuthorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new Error("xAI OAuth discovery response is missing device code endpoints");
  }
  return {
    deviceAuthorizationEndpoint: requireTrustedXaiOAuthEndpoint(
      deviceAuthorizationEndpoint,
      "device authorization endpoint",
    ),
    tokenEndpoint: requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint"),
  };
}

function normalizeExpires(value: unknown, now: () => number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now() });
}

function parseXaiOAuthTokenResponse(
  value: unknown,
  now: () => number,
  options: { requireRefreshToken?: boolean } = {},
): XaiOAuthTokenResponse {
  const json = readStringRecord(value);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("xAI OAuth token response is missing access_token");
  }
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token.trim().length > 0
      ? json.refresh_token
      : undefined;
  if (options.requireRefreshToken && !refreshToken) {
    throw new Error(
      "xAI OAuth token response is missing refresh_token. Re-run the login; if the issue persists, the OAuth client is not configured to issue refresh tokens (commonly because the offline_access scope was rejected).",
    );
  }
  const idToken =
    typeof json.id_token === "string" && json.id_token.trim().length > 0
      ? json.id_token
      : undefined;
  // RFC 6749 expires_in preferred; access-token JWT exp is the only legitimate
  // fallback for an access-token expiry — id_token exp reflects the OIDC
  // session, not the access token, and may extend it past actual expiry.
  const expires = normalizeExpires(json.expires_in, now) ?? deriveExpiresFromJwt(accessToken);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expires ? { expires } : {}),
  };
}

function deriveExpiresFromJwt(token: string | undefined): number | undefined {
  if (!token) {
    return undefined;
  }
  const payload = decodeJwtPayload(token);
  const exp = payload.exp;
  return resolveExpiresAtMsFromEpochSeconds(exp);
}

function parseXaiOAuthErrorResponse(value: unknown): XaiOAuthErrorResponse {
  const json = readStringRecord(value);
  const error = typeof json.error === "string" ? json.error : undefined;
  const errorDescription =
    typeof json.error_description === "string" ? json.error_description : undefined;
  return {
    ...(error ? { error } : {}),
    ...(errorDescription ? { errorDescription } : {}),
  };
}

function formatXaiOAuthError(params: { context: string; status: number; body: unknown }): string {
  const error = parseXaiOAuthErrorResponse(params.body);
  if (error.error && error.errorDescription) {
    return `${params.context} failed (${params.status}): ${error.error} (${error.errorDescription})`;
  }
  if (error.error) {
    return `${params.context} failed (${params.status}): ${error.error}`;
  }
  return `${params.context} failed (${params.status})`;
}

function isLikelyXaiCloudflareChallenge(params: { response: Response; bodyText: string }): boolean {
  const contentType = params.response.headers.get("content-type") ?? "";
  return (
    params.response.headers.get("cf-mitigated") === "challenge" ||
    /text\/html/i.test(contentType) ||
    /<!doctype html|<html\b/i.test(params.bodyText) ||
    /\b(?:cloudflare|attention required|just a moment|enable javascript and cookies|challenge-platform)\b/i.test(
      params.bodyText,
    )
  );
}

function formatXaiOAuthCloudflareChallengeError(params: {
  context: string;
  status: number;
}): string {
  return (
    `${params.context} failed (${params.status}): xAI returned an HTML/Cloudflare challenge ` +
    "instead of OAuth JSON. xAI may be blocking the automated token refresh; try again later " +
    "or re-run xAI OAuth login."
  );
}

/**
 * Single source of truth for how a non-OK token response is reported and whether
 * it is worth retrying. Detection runs once so the message and the retry decision
 * never disagree: a structured OAuth error (e.g. invalid_grant) is authoritative
 * and final, while intermediary Cloudflare HTML challenges are retryable.
 */
function describeXaiOAuthTokenFailure(params: {
  context: string;
  response: Response;
  body: XaiOAuthResponseBody;
}): { message: string; retryable: boolean } {
  const { context, response, body } = params;
  const status = response.status;
  const hasStructuredError = Boolean(parseXaiOAuthErrorResponse(body.json).error);
  const isCloudflareChallenge =
    !hasStructuredError && isLikelyXaiCloudflareChallenge({ response, bodyText: body.text });
  return {
    message: isCloudflareChallenge
      ? formatXaiOAuthCloudflareChallengeError({ context, status })
      : formatXaiOAuthError({ context, status, body: body.json }),
    retryable: isCloudflareChallenge,
  };
}

async function exchangeXaiOAuthToken(
  params: {
    tokenEndpoint: string;
    body: Record<string, string>;
    context: string;
    requireRefreshToken?: boolean;
  } & XaiOAuthFetchOptions,
): Promise<XaiOAuthTokenResponse> {
  const endpoint = requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, "token endpoint");
  const maxAttempts =
    params.body.grant_type === "refresh_token" ? XAI_OAUTH_REFRESH_MAX_ATTEMPTS : 1;
  let lastMessage = `${params.context} failed`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await getFetchImpl(params.fetchImpl)(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": xaiUserAgent(),
        },
        body: toFormUrlEncoded(params.body),
        signal: xaiOAuthFetchSignal(params.signal),
      });
    } catch (err) {
      // Transport failures are not safe to retry for refresh grants: xAI rotates
      // refresh tokens, so a response lost after xAI consumed the token would burn
      // it on resend. Only Cloudflare challenge responses are retried below.
      throw new Error(`${params.context} failed: ${formatErrorMessage(err)}`, { cause: err });
    }
    const body = await readResponseBody(response);
    if (response.ok) {
      return parseXaiOAuthTokenResponse(body.json, params.now ?? Date.now, {
        requireRefreshToken: params.requireRefreshToken,
      });
    }

    const failure = describeXaiOAuthTokenFailure({ context: params.context, response, body });
    lastMessage = failure.message;
    if (attempt >= maxAttempts || !failure.retryable) {
      throw new Error(lastMessage);
    }
    await sleep(XAI_OAUTH_REFRESH_RETRY_DELAY_MS);
  }

  throw new Error(lastMessage);
}

async function requestXaiDeviceCode(
  params: {
    deviceAuthorizationEndpoint: string;
  } & XaiOAuthFetchOptions,
): Promise<XaiDeviceCodeResponse> {
  const response = await getFetchImpl(params.fetchImpl)(
    requireTrustedXaiOAuthEndpoint(
      params.deviceAuthorizationEndpoint,
      "device authorization endpoint",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": xaiUserAgent(),
      },
      body: toFormUrlEncoded({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }),
      signal: xaiOAuthFetchSignal(params.signal),
    },
  );
  const json = readStringRecord(await readJsonResponse(response, "xAI device code request"));
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const verificationUriComplete = json.verification_uri_complete;
  if (
    typeof deviceCode !== "string" ||
    deviceCode.trim().length === 0 ||
    typeof userCode !== "string" ||
    userCode.trim().length === 0 ||
    typeof verificationUri !== "string" ||
    verificationUri.trim().length === 0
  ) {
    throw new Error(
      "xAI device code response is missing device_code, user_code, or verification_uri",
    );
  }
  const trustedVerificationUri = requireTrustedXaiOAuthEndpoint(
    verificationUri,
    "device verification URI",
  );
  const trustedVerificationUriComplete =
    typeof verificationUriComplete === "string" && verificationUriComplete.trim().length > 0
      ? requireTrustedXaiOAuthEndpoint(verificationUriComplete, "complete device verification URI")
      : undefined;
  return {
    deviceCode,
    userCode,
    verificationUri: trustedVerificationUri,
    ...(trustedVerificationUriComplete
      ? { verificationUriComplete: trustedVerificationUriComplete }
      : {}),
    expiresInMs: positiveSecondsToSafeMilliseconds(json.expires_in) ?? XAI_OAUTH_TIMEOUT_MS,
    intervalMs:
      positiveSecondsToSafeMilliseconds(json.interval) ?? XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

function resolveNextXaiDeviceCodePollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, XAI_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

async function pollXaiDeviceCodeToken(
  params: {
    tokenEndpoint: string;
    deviceCode: string;
    expiresInMs: number;
    intervalMs: number;
  } & XaiOAuthFetchOptions,
): Promise<XaiOAuthTokenResponse> {
  const fetchImpl = getFetchImpl(params.fetchImpl);
  const deadlineMs = Date.now() + params.expiresInMs;
  let intervalMs = params.intervalMs;

  while (Date.now() < deadlineMs) {
    const response = await fetchImpl(
      requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, "token endpoint"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": xaiUserAgent(),
        },
        body: toFormUrlEncoded({
          grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
          client_id: XAI_OAUTH_CLIENT_ID,
          device_code: params.deviceCode,
        }),
        signal: xaiOAuthFetchSignal(params.signal),
      },
    );
    let body: unknown;
    try {
      const buffer = await readResponseWithLimit(response, XAI_OAUTH_RESPONSE_MAX_BYTES, {
        onOverflow: ({ maxBytes }) =>
          new Error(`xAI device code response exceeds ${maxBytes} bytes`),
      });
      body = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      body = null;
    }
    if (response.ok) {
      return parseXaiOAuthTokenResponse(body, params.now ?? Date.now, {
        requireRefreshToken: true,
      });
    }

    const error = parseXaiOAuthErrorResponse(body).error;
    if (error === "authorization_pending") {
      await waitForXaiDeviceCodePoll(
        resolveNextXaiDeviceCodePollDelayMs(intervalMs, deadlineMs),
        params.signal,
      );
      continue;
    }
    if (error === "slow_down") {
      intervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await waitForXaiDeviceCodePoll(
        resolveNextXaiDeviceCodePollDelayMs(intervalMs, deadlineMs),
        params.signal,
      );
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (error === "expired_token") {
      throw new Error("xAI device code expired. Re-run the login.");
    }

    throw new Error(
      formatXaiOAuthError({
        context: "xAI device token exchange",
        status: response.status,
        body,
      }),
    );
  }

  throw new Error("xAI device authorization timed out");
}

async function waitForXaiDeviceCodePoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason instanceof Error ? signal.reason : new Error("xAI login cancelled"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) {
    return {};
  }
  const part = token.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return readStringRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function resolveXaiOAuthIdentity(tokens: XaiOAuthTokenResponse): XaiOAuthIdentity {
  const payload = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  return {
    ...(email ? { email } : {}),
    ...(name ? { displayName: name } : {}),
    ...(sub ? { accountId: sub } : {}),
  };
}

function readCredentialString<TKey extends string>(
  credential: OAuthCredential & Partial<Record<TKey, unknown>>,
  key: TKey,
): string | undefined {
  const value = credential[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isLegacyXaiOAuthTokenEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}` === XAI_LEGACY_OAUTH_TOKEN_ENDPOINT;
  } catch {
    return false;
  }
}

async function resolveXaiOAuthRefreshTokenEndpoint(
  credential: OAuthCredential,
  options: XaiOAuthFetchOptions,
): Promise<string> {
  const cachedEndpoint = readCredentialString(credential, "tokenEndpoint");
  // Rediscover when there is no cached endpoint, or when an older persisted
  // credential still points at the retired endpoint, so refresh writes back the
  // current OAuth token endpoint.
  if (!cachedEndpoint || isLegacyXaiOAuthTokenEndpoint(cachedEndpoint)) {
    return (await fetchXaiOAuthDiscovery(options)).tokenEndpoint;
  }
  return cachedEndpoint;
}

async function noteXaiDeviceCode(
  ctx: ProviderAuthContext,
  deviceCode: XaiDeviceCodeResponse,
): Promise<void> {
  const expiresInMinutes = Math.max(1, Math.round(deviceCode.expiresInMs / 60_000));
  if (ctx.prompter.deviceCode) {
    await ctx.prompter.deviceCode({
      title: "xAI OAuth",
      code: deviceCode.userCode,
      expiresInMinutes,
      message: "Enter this one-time code on the xAI sign-in page.",
    });
    return;
  }
  await ctx.prompter.note(
    [
      ctx.isRemote
        ? "Open this URL in your LOCAL browser and enter the code below."
        : "Open this URL in your browser and enter the code below.",
      `URL: ${deviceCode.verificationUriComplete ?? deviceCode.verificationUri}`,
      `Code: ${deviceCode.userCode}`,
      `Code expires in ${expiresInMinutes} minutes. Never share it.`,
    ].join("\n"),
    "xAI OAuth",
  );
}

async function loginXaiDeviceCode(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting xAI OAuth...");
  try {
    const discovery = await fetchXaiDeviceCodeDiscovery(
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    progress.update("Requesting xAI OAuth device code...");
    const deviceCode = await requestXaiDeviceCode({
      deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const browserUrl = deviceCode.verificationUriComplete ?? deviceCode.verificationUri;
    let openedBrowser = false;
    try {
      await ctx.openUrl(browserUrl);
      openedBrowser = true;
    } catch {
      ctx.runtime.log(`Open manually: ${deviceCode.verificationUri}`);
    }
    await noteXaiDeviceCode(ctx, deviceCode);
    const logUrl = deviceCode.verificationUri;
    if (ctx.isRemote) {
      ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${logUrl}\n`);
    } else if (openedBrowser) {
      ctx.runtime.log(`Open: ${logUrl}`);
    }

    progress.update("Waiting for xAI device authorization...");
    const tokens = await pollXaiDeviceCodeToken({
      tokenEndpoint: discovery.tokenEndpoint,
      deviceCode: deviceCode.deviceCode,
      expiresInMs: deviceCode.expiresInMs,
      intervalMs: deviceCode.intervalMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const identity = resolveXaiOAuthIdentity(tokens);
    progress.stop("xAI OAuth complete");
    return buildOauthProviderAuthResult({
      providerId: PROVIDER_ID,
      defaultModel: XAI_DEFAULT_MODEL_REF,
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expires,
      email: identity.email,
      displayName: identity.displayName,
      profileName: identity.email ?? identity.accountId,
      configPatch: applyXaiConfig(ctx.config),
      credentialExtra: {
        tokenEndpoint: discovery.tokenEndpoint,
        deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
        issuer: XAI_OAUTH_ISSUER,
        authFlow: "device-code",
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(identity.accountId ? { accountId: identity.accountId } : {}),
      },
      notes: [
        "xAI OAuth uses device-code verification without requiring a localhost callback.",
        "xAI may label the consent app as Grok Build because OpenClaw uses xAI's shared OAuth client.",
      ],
    });
  } catch (err) {
    progress.stop("xAI OAuth failed");
    throw new Error(`xAI OAuth failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

export async function refreshXaiOAuthCredential(
  credential: OAuthCredential,
  options: XaiOAuthFetchOptions = {},
): Promise<OAuthCredential> {
  const refreshToken = credential.refresh;
  if (!refreshToken) {
    throw new Error("xAI OAuth credential is missing refresh token");
  }
  const tokenEndpoint = await resolveXaiOAuthRefreshTokenEndpoint(credential, options);
  const tokens = await exchangeXaiOAuthToken({
    ...options,
    tokenEndpoint,
    context: "xAI OAuth refresh",
    body: {
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    },
  });
  const identity = resolveXaiOAuthIdentity(tokens);
  return {
    ...credential,
    type: "oauth",
    provider: PROVIDER_ID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken ?? refreshToken,
    ...(tokens.expires ? { expires: tokens.expires } : {}),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    tokenEndpoint,
    issuer: XAI_OAUTH_ISSUER,
  } as OAuthCredential;
}

export function createXaiOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_OAUTH_METHOD_ID,
    label: "xAI OAuth",
    hint: "Remote-friendly browser sign-in without a localhost callback",
    kind: "oauth",
    wizard: {
      choiceId: XAI_OAUTH_CHOICE_ID,
      choiceLabel: "xAI OAuth",
      choiceHint: "Remote-friendly browser sign-in without a localhost callback",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or OAuth",
      methodId: XAI_OAUTH_METHOD_ID,
    },
    run: async (ctx) => loginXaiDeviceCode(ctx),
  };
}

export function createXaiDeviceCodeAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_DEVICE_CODE_METHOD_ID,
    label: "xAI device code",
    hint: "Deprecated alias for xAI OAuth device-code login",
    kind: "device_code",
    wizard: {
      choiceId: XAI_DEVICE_CODE_CHOICE_ID,
      choiceLabel: "xAI device code",
      choiceHint: "Compatibility alias for xAI OAuth device-code sign-in",
      assistantVisibility: "manual-only",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or OAuth",
      methodId: XAI_DEVICE_CODE_METHOD_ID,
    },
    run: async (ctx) => loginXaiDeviceCode(ctx),
  };
}
