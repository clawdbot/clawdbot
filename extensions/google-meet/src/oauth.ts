import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const GOOGLE_MEET_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const GOOGLE_MEET_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_MEET_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_MEET_TOKEN_HOST = "oauth2.googleapis.com";
const GOOGLE_MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/meetings.conference.media.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
] as const;

export type GoogleMeetOAuthTokens = {
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
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google OAuth token request failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };
    const accessToken = payload.access_token?.trim();
    if (!accessToken) {
      throw new Error("Google OAuth token response was missing access_token");
    }
    const expiresInSeconds =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;
    return {
      accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
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

export async function refreshGoogleMeetAccessToken(params: {
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
  const callback = await waitForLocalOAuthCallback({
    expectedState: params.state,
    timeoutMs: params.timeoutMs,
    port: 8085,
    callbackPath: "/oauth2callback",
    redirectUri: GOOGLE_MEET_REDIRECT_URI,
    successTitle: "Google Meet OAuth complete",
  });
  return callback.code;
}
