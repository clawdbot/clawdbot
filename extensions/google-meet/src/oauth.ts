// Google Meet plugin module implements oauth behavior.
import {
  MAX_DATE_TIMESTAMP_MS,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { readGoogleApiErrorDetail } from "./google-api-errors.js";

const GOOGLE_MEET_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const GOOGLE_MEET_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_MEET_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_MEET_TOKEN_HOST = "oauth2.googleapis.com";
const GOOGLE_MEET_DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const GOOGLE_OAUTH_TOKEN_JSON_MAX_BYTES = 256 * 1024;
const GOOGLE_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/meetings.conference.media.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
] as const;

function resolveGoogleMeetTokenExpiresAt(value: unknown, nowMs = Date.now()): number {
  const now = resolveDateTimestampMs(nowMs);
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now }) ??
    resolveExpiresAtMsFromDurationSeconds(GOOGLE_MEET_DEFAULT_TOKEN_LIFETIME_SECONDS, {
      nowMs: now,
    }) ??
    now
  );
}

type GoogleMeetOAuthTokens = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
};

export function buildGoogleMeetAuthUrl(params: {
  clientId: string;
  challenge: string;
  state: string;
  redirectUri?: string;
  scopes?: readonly string[];
}): string {
  const search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri ?? GOOGLE_MEET_REDIRECT_URI,
    scope: (params.scopes ?? GOOGLE_MEET_SCOPES).join(" "),
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: params.state,
  });
  return `${GOOGLE_MEET_AUTH_URL}?${search.toString()}`;
}

async function executeGoogleTokenRequest(body: URLSearchParams): Promise<GoogleMeetOAuthTokens> {
  const { response, release } = await fetchWithSsrFGuard({
    url: GOOGLE_MEET_TOKEN_URL,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
    },
    policy: { allowedHostnames: [GOOGLE_MEET_TOKEN_HOST] },
    auditContext: "google-meet.oauth.token",
    timeoutMs: GOOGLE_OAUTH_REQUEST_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      const detail = await readGoogleApiErrorDetail(response);
      throw new Error(`Google OAuth token request failed (${response.status}): ${detail}`);
    }
    const payload = await readProviderJsonResponse<{
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    }>(response, "Google OAuth token", { maxBytes: GOOGLE_OAUTH_TOKEN_JSON_MAX_BYTES });
    const accessToken = payload.access_token?.trim();
    if (!accessToken) {
      throw new Error("Google OAuth token response was missing access_token");
    }
    return {
      accessToken,
      expiresAt: resolveGoogleMeetTokenExpiresAt(payload.expires_in),
      refreshToken: payload.refresh_token?.trim() || undefined,
      scope: payload.scope?.trim() || undefined,
      tokenType: payload.token_type?.trim() || undefined,
    };
  } finally {
    await release();
  }
}

function tokenRequestBody(values: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value?.trim()) {
      body.set(key, value);
    }
  }
  return body;
}

export async function exchangeGoogleMeetAuthCode(params: {
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri?: string;
}): Promise<GoogleMeetOAuthTokens> {
  return await executeGoogleTokenRequest(
    tokenRequestBody({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri ?? GOOGLE_MEET_REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  );
}

async function refreshGoogleMeetAccessToken(params: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<GoogleMeetOAuthTokens> {
  return await executeGoogleTokenRequest(
    tokenRequestBody({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
  );
}

function shouldUseCachedGoogleMeetAccessToken(params: {
  accessToken?: string;
  expiresAt?: number;
  now?: number;
  safetyWindowMs?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const safetyWindowMs = params.safetyWindowMs ?? 60_000;
  return Boolean(
    params.accessToken?.trim() &&
    typeof params.expiresAt === "number" &&
    Number.isFinite(params.expiresAt) &&
    params.expiresAt <= MAX_DATE_TIMESTAMP_MS &&
    params.expiresAt > now + safetyWindowMs,
  );
}

export async function resolveGoogleMeetAccessToken(params: {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}): Promise<{ accessToken: string; expiresAt?: number; refreshed: boolean }> {
  if (shouldUseCachedGoogleMeetAccessToken(params)) {
    return {
      accessToken: params.accessToken!.trim(),
      expiresAt: params.expiresAt,
      refreshed: false,
    };
  }
  if (!params.clientId?.trim() || !params.refreshToken?.trim()) {
    throw new Error(
      "Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.",
    );
  }
  const refreshed = await refreshGoogleMeetAccessToken({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    refreshToken: params.refreshToken,
  });
  return {
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    refreshed: true,
  };
}

export function createGoogleMeetPkce() {
  const { verifier, challenge } = generateHexPkceVerifierChallenge();
  return { verifier, challenge };
}

export function createGoogleMeetOAuthState(): string {
  return generateOAuthState();
}

function isLocalCallbackListenerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("EADDRINUSE") ||
    error.message.includes("port") ||
    error.message.includes("listen")
  );
}

async function readManualGoogleMeetAuthCode(params: {
  state: string;
  promptInput: (message: string) => Promise<string>;
}): Promise<string> {
  const input = await params.promptInput("Paste the full redirect URL here: ");
  const parsed = parseOAuthCallbackInput(input, {
    missingState: "Missing 'state' parameter. Paste the full redirect URL.",
    invalidInput: "Paste the full redirect URL, not just the code.",
  });
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  if (parsed.state !== params.state) {
    throw new Error("OAuth state mismatch - please try again");
  }
  return parsed.code;
}

export async function waitForGoogleMeetAuthCode(params: {
  state: string;
  manual: boolean;
  timeoutMs: number;
  authUrl: string;
  promptInput: (message: string) => Promise<string>;
  writeLine: (message: string) => void;
}): Promise<string> {
  params.writeLine(`Open this URL in your browser:\n\n${params.authUrl}\n`);
  if (params.manual) {
    return await readManualGoogleMeetAuthCode({
      state: params.state,
      promptInput: params.promptInput,
    });
  }
  try {
    const callback = await waitForLocalOAuthCallback({
      expectedState: params.state,
      timeoutMs: params.timeoutMs,
      port: 8085,
      callbackPath: "/oauth2callback",
      redirectUri: GOOGLE_MEET_REDIRECT_URI,
      successTitle: "Google Meet OAuth complete",
    });
    return callback.code;
  } catch (error) {
    if (!isLocalCallbackListenerError(error)) {
      throw error;
    }
    params.writeLine("Local callback server failed. Switching to manual mode...");
    return await readManualGoogleMeetAuthCode({
      state: params.state,
      promptInput: params.promptInput,
    });
  }
}
