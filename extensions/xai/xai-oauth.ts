import { randomBytes } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  generateHexPkceVerifierChallenge,
  toFormUrlEncoded,
  type OAuthCredential,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { waitForLocalOAuthCallback } from "openclaw/plugin-sdk/provider-auth-runtime";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { xaiUserAgent } from "./src/xai-user-agent.js";

const PROVIDER_ID = "xai";
export const XAI_OAUTH_METHOD_ID = "oauth";
export const XAI_OAUTH_CHOICE_ID = "xai-oauth";
export const XAI_DEVICE_CODE_METHOD_ID = "device-code";
export const XAI_DEVICE_CODE_CHOICE_ID = "xai-device-code";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CALLBACK_HOST = "127.0.0.1";
export const XAI_OAUTH_CALLBACK_PORT = 56121;
export const XAI_OAUTH_CALLBACK_PATH = "/callback";
export const XAI_OAUTH_REDIRECT_URI = `http://${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT}${XAI_OAUTH_CALLBACK_PATH}`;
// Hosts whose CORS preflight against the loopback redirect URI should be
// echoed; everything else gets a 204 with no `Access-Control-Allow-*`.
export const XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST = ["auth.x.ai", "accounts.x.ai"] as const;

const XAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5 * 1000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1 * 1000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5 * 1000;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type XaiOAuthDiscovery = {
  authorizationEndpoint: string;
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
};

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

function getFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

export function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
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

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const errorText = readStringRecord(body).error_description ?? readStringRecord(body).error;
    throw new Error(
      `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
    );
  }
  return body;
}

async function fetchXaiOAuthDiscoveryDocument(
  options: XaiOAuthFetchOptions = {},
): Promise<Record<string, unknown>> {
  const response = await getFetchImpl(options.fetchImpl)(XAI_OAUTH_DISCOVERY_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": xaiUserAgent(),
    },
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  return readStringRecord(await readJsonResponse(response, "xAI OAuth discovery"));
}

export async function fetchXaiOAuthDiscovery(
  options: XaiOAuthFetchOptions = {},
): Promise<XaiOAuthDiscovery> {
  const json = await fetchXaiOAuthDiscoveryDocument(options);
  const authorizationEndpoint = json.authorization_endpoint;
  const tokenEndpoint = json.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new Error("xAI OAuth discovery response is missing endpoints");
  }
  return {
    authorizationEndpoint: requireTrustedXaiOAuthEndpoint(
      authorizationEndpoint,
      "authorization endpoint",
    ),
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

export function buildXaiOAuthAuthorizeUrl(params: {
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const url = new URL(
    requireTrustedXaiOAuthEndpoint(params.authorizationEndpoint, "authorization endpoint"),
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", XAI_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", XAI_OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("plan", "generic");
  url.searchParams.set("referrer", "openclaw");
  return url.toString();
}

export function buildXaiOAuthAuthorizationCodeTokenBody(params: {
  code: string;
  codeVerifier: string;
  codeChallenge: string;
}): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: XAI_OAUTH_REDIRECT_URI,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: params.codeVerifier,
    // xAI validates these PKCE fields again at token exchange for this client.
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  };
}

function normalizeExpires(value: unknown, now: () => number): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return now() + seconds * 1000;
}

function normalizePositiveSecondsToMs(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.trunc(seconds * 1000);
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
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
    return undefined;
  }
  return exp * 1000;
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

async function exchangeXaiOAuthToken(
  params: {
    tokenEndpoint: string;
    body: Record<string, string>;
    context: string;
    requireRefreshToken?: boolean;
  } & XaiOAuthFetchOptions,
): Promise<XaiOAuthTokenResponse> {
  const response = await getFetchImpl(params.fetchImpl)(
    requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, "token endpoint"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": xaiUserAgent(),
      },
      body: toFormUrlEncoded(params.body),
      signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
    },
  );
  return parseXaiOAuthTokenResponse(
    await readJsonResponse(response, params.context),
    params.now ?? Date.now,
    { requireRefreshToken: params.requireRefreshToken },
  );
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
      signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
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
    expiresInMs: normalizePositiveSecondsToMs(json.expires_in) ?? XAI_OAUTH_TIMEOUT_MS,
    intervalMs: normalizePositiveSecondsToMs(json.interval) ?? XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS,
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
        signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
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
      await new Promise((resolve) =>
        setTimeout(resolve, resolveNextXaiDeviceCodePollDelayMs(intervalMs, deadlineMs)),
      );
      continue;
    }
    if (error === "slow_down") {
      intervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await new Promise((resolve) =>
        setTimeout(resolve, resolveNextXaiDeviceCodePollDelayMs(intervalMs, deadlineMs)),
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

async function noteXaiOAuthUrl(ctx: ProviderAuthContext, authorizeUrl: string): Promise<void> {
  const lines = ["Open this xAI OAuth URL in your browser:", authorizeUrl];
  if (ctx.isRemote) {
    lines.push(
      "",
      "Remote host: forward the callback before signing in:",
      `ssh -N -L ${XAI_OAUTH_CALLBACK_PORT}:${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT} <host>`,
    );
  }
  await ctx.prompter.note(lines.join("\n"), "xAI OAuth");
}

export async function loginXaiOAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting xAI OAuth...");
  try {
    const discovery = await fetchXaiOAuthDiscovery();
    const pkce = generateHexPkceVerifierChallenge();
    const state = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const authorizeUrl = buildXaiOAuthAuthorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      state,
      nonce,
      challenge: pkce.challenge,
    });
    progress.update(`Waiting for xAI OAuth callback on ${XAI_OAUTH_REDIRECT_URI}...`);
    const callbackPromise = waitForLocalOAuthCallback({
      expectedState: state,
      timeoutMs: XAI_OAUTH_TIMEOUT_MS,
      port: XAI_OAUTH_CALLBACK_PORT,
      callbackPath: XAI_OAUTH_CALLBACK_PATH,
      redirectUri: XAI_OAUTH_REDIRECT_URI,
      hostname: XAI_OAUTH_CALLBACK_HOST,
      successTitle: "xAI OAuth complete",
      onProgress: (message) => progress.update(message),
      corsOriginAllowlist: XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST,
    });
    void callbackPromise.catch(() => undefined);
    await noteXaiOAuthUrl(ctx, authorizeUrl);
    if (!ctx.isRemote) {
      await ctx.openUrl(authorizeUrl);
    }
    const callback = await callbackPromise;
    const tokens = await exchangeXaiOAuthToken({
      tokenEndpoint: discovery.tokenEndpoint,
      context: "xAI OAuth token exchange",
      requireRefreshToken: true,
      body: buildXaiOAuthAuthorizationCodeTokenBody({
        code: callback.code,
        codeVerifier: pkce.verifier,
        codeChallenge: pkce.challenge,
      }),
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
        issuer: XAI_OAUTH_ISSUER,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(identity.accountId ? { accountId: identity.accountId } : {}),
      },
      notes: [
        "xAI OAuth uses your xAI account entitlement; xAI API keys still work.",
        "xAI may label the consent app as Grok Build because OpenClaw uses xAI's shared OAuth client.",
      ],
    });
  } catch (err) {
    progress.stop("xAI OAuth failed");
    throw new Error(`xAI OAuth failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

async function noteXaiDeviceCode(
  ctx: ProviderAuthContext,
  deviceCode: XaiDeviceCodeResponse,
): Promise<void> {
  const expiresInMinutes = Math.max(1, Math.round(deviceCode.expiresInMs / 60_000));
  await ctx.prompter.note(
    [
      ctx.isRemote
        ? "Open this URL in your LOCAL browser and enter the code below."
        : "Open this URL in your browser and enter the code below.",
      `URL: ${deviceCode.verificationUriComplete ?? deviceCode.verificationUri}`,
      `Code: ${deviceCode.userCode}`,
      `Code expires in ${expiresInMinutes} minutes. Never share it.`,
    ].join("\n"),
    "xAI device code",
  );
}

export async function loginXaiDeviceCode(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting xAI device code flow...");
  try {
    const discovery = await fetchXaiDeviceCodeDiscovery();
    progress.update("Requesting xAI device code...");
    const deviceCode = await requestXaiDeviceCode({
      deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
    });
    await noteXaiDeviceCode(ctx, deviceCode);
    const browserUrl = deviceCode.verificationUriComplete ?? deviceCode.verificationUri;
    const logUrl = deviceCode.verificationUri;
    if (ctx.isRemote) {
      ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${logUrl}\n`);
    } else {
      try {
        await ctx.openUrl(browserUrl);
        ctx.runtime.log(`Open: ${logUrl}`);
      } catch {
        ctx.runtime.log(`Open manually: ${logUrl}`);
      }
    }

    progress.update("Waiting for xAI device authorization...");
    const tokens = await pollXaiDeviceCodeToken({
      tokenEndpoint: discovery.tokenEndpoint,
      deviceCode: deviceCode.deviceCode,
      expiresInMs: deviceCode.expiresInMs,
      intervalMs: deviceCode.intervalMs,
    });
    const identity = resolveXaiOAuthIdentity(tokens);
    progress.stop("xAI device code complete");
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
        "xAI device code login uses your xAI account entitlement without requiring a localhost callback.",
        "xAI may label the consent app as Grok Build because OpenClaw uses xAI's shared OAuth client.",
      ],
    });
  } catch (err) {
    progress.stop("xAI device code failed");
    throw new Error(`xAI device code failed: ${formatErrorMessage(err)}`, { cause: err });
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
  const tokenEndpoint =
    readCredentialString(credential, "tokenEndpoint") ??
    (await fetchXaiOAuthDiscovery(options)).tokenEndpoint;
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
    hint: "Browser sign-in for eligible xAI accounts",
    kind: "oauth",
    wizard: {
      choiceId: XAI_OAUTH_CHOICE_ID,
      choiceLabel: "xAI OAuth",
      choiceHint: "Browser sign-in for eligible xAI accounts",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or browser OAuth",
      methodId: XAI_OAUTH_METHOD_ID,
    },
    run: async (ctx) => loginXaiOAuth(ctx),
  };
}

export function createXaiDeviceCodeAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_DEVICE_CODE_METHOD_ID,
    label: "xAI device code",
    hint: "Remote-friendly browser sign-in without a localhost callback",
    kind: "device_code",
    wizard: {
      choiceId: XAI_DEVICE_CODE_CHOICE_ID,
      choiceLabel: "xAI device code",
      choiceHint: "Remote-friendly browser sign-in without a localhost callback",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or browser OAuth",
      methodId: XAI_DEVICE_CODE_METHOD_ID,
    },
    run: async (ctx) => loginXaiDeviceCode(ctx),
  };
}
