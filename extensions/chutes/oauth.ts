import { randomBytes } from "node:crypto";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { generatePkceVerifierChallenge, toFormUrlEncoded } from "openclaw/plugin-sdk/provider-auth";
import {
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHUTES_AUTHORIZE_ENDPOINT = "https://api.chutes.ai/idp/authorize";
const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";

type OAuthPrompt = {
  message: string;
  placeholder?: string;
};

type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};

type ChutesUserInfo = {
  sub?: string;
  username?: string;
};

type ChutesStoredOAuth = OAuthCredentials & {
  accountId?: string;
  clientId?: string;
};

function parseRedirectUri(redirectUri: string): {
  hostname: string;
  port: number;
  pathname: string;
} {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:") {
    throw new Error(`Chutes OAuth redirect URI must be http:// (got ${redirectUri})`);
  }
  const hostname = url.hostname || "127.0.0.1";
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error(
      `Chutes OAuth redirect hostname must be loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`,
    );
  }
  return {
    hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 80,
    pathname: url.pathname || "/",
  };
}

function parseManualOAuthInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const parsed = parseOAuthCallbackInput(input, {
    invalidInput: "Paste the full redirect URL (must include code + state).",
    missingState: "Missing 'state' parameter. Paste the full redirect URL.",
  });
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  if (parsed.state !== expectedState) {
    throw new Error("OAuth state mismatch - possible CSRF attack. Please retry login.");
  }
  return parsed;
}

function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  });
  return `${CHUTES_AUTHORIZE_ENDPOINT}?${qs.toString()}`;
}

function coerceExpiresAt(expiresInSeconds: number, now: number): number {
  const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1000 - 5 * 60 * 1000;
  return Math.max(value, now + 30_000);
}

async function fetchChutesUserInfo(params: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<ChutesUserInfo | null> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(CHUTES_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as unknown;
  return data && typeof data === "object" ? (data as ChutesUserInfo) : null;
}

async function exchangeChutesCodeForTokens(params: {
  app: ChutesOAuthAppConfig;
  code: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<ChutesStoredOAuth> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();
  const body = new URLSearchParams(
    toFormUrlEncoded({
      grant_type: "authorization_code",
      client_id: params.app.clientId,
      code: params.code,
      redirect_uri: params.app.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  );
  if (params.app.clientSecret) {
    body.set("client_secret", params.app.clientSecret);
  }

  const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Chutes token exchange failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const access = normalizeOptionalString(data.access_token);
  const refresh = normalizeOptionalString(data.refresh_token);
  if (!access) {
    throw new Error("Chutes token exchange returned no access_token");
  }
  if (!refresh) {
    throw new Error("Chutes token exchange returned no refresh_token");
  }

  const info = await fetchChutesUserInfo({ accessToken: access, fetchFn });
  return {
    access,
    refresh,
    expires: coerceExpiresAt(data.expires_in ?? 0, now),
    email: info?.username,
    accountId: info?.sub,
    clientId: params.app.clientId,
  } as ChutesStoredOAuth;
}

export async function loginChutes(params: {
  app: ChutesOAuthAppConfig;
  manual?: boolean;
  timeoutMs?: number;
  createState?: () => string;
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  fetchFn?: typeof fetch;
}): Promise<ChutesStoredOAuth> {
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = params.createState?.() ?? randomBytes(16).toString("hex");
  const timeoutMs = params.timeoutMs ?? 3 * 60 * 1000;
  const url = buildAuthorizeUrl({
    clientId: params.app.clientId,
    redirectUri: params.app.redirectUri,
    scopes: params.app.scopes,
    state,
    challenge,
  });

  let codeAndState: { code: string; state: string };
  if (params.manual) {
    await params.onAuth({ url });
    params.onProgress?.("Waiting for redirect URL...");
    codeAndState = parseManualOAuthInput(
      await params.onPrompt({
        message: "Paste the redirect URL",
        placeholder: `${params.app.redirectUri}?code=...&state=...`,
      }),
      state,
    );
  } else {
    const redirect = parseRedirectUri(params.app.redirectUri);
    const callback = waitForLocalOAuthCallback({
      expectedState: state,
      timeoutMs,
      port: redirect.port,
      callbackPath: redirect.pathname,
      redirectUri: params.app.redirectUri,
      successTitle: "Chutes OAuth complete",
      hostname: redirect.hostname,
      onProgress: params.onProgress,
    }).catch(async () => {
      params.onProgress?.("OAuth callback not detected; paste redirect URL...");
      return parseManualOAuthInput(
        await params.onPrompt({
          message: "Paste the redirect URL",
          placeholder: `${params.app.redirectUri}?code=...&state=...`,
        }),
        state,
      );
    });

    await params.onAuth({ url });
    codeAndState = await callback;
  }

  params.onProgress?.("Exchanging code for tokens...");
  return await exchangeChutesCodeForTokens({
    app: params.app,
    code: codeAndState.code,
    codeVerifier: verifier,
    fetchFn: params.fetchFn,
  });
}
