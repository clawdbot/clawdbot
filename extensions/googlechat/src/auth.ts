import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { readJsonFile, readRefreshTokenFromFile } from "./file-utils.js";
import { readGogRefreshTokenSync, resolveGogCredentialsFile } from "./gog.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
const oauthCache = new Map<string, { key: string; client: OAuth2Client }>();
const verifyClient = new OAuth2Client();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

function buildAuthKey(account: ResolvedGoogleChatAccount): string {
  if (account.credentialsFile) return `file:${account.credentialsFile}`;
  if (account.credentials) return `inline:${JSON.stringify(account.credentials)}`;
  return "none";
}

function getAuthInstance(account: ResolvedGoogleChatAccount): GoogleAuth {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) return cached.auth;

  if (account.credentialsFile) {
    const auth = new GoogleAuth({ keyFile: account.credentialsFile, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    return auth;
  }

  if (account.credentials) {
    const auth = new GoogleAuth({ credentials: account.credentials, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    return auth;
  }

  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] });
  authCache.set(account.accountId, { key, auth });
  return auth;
}

export async function getGoogleChatAppAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const auth = getAuthInstance(account);
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) {
    throw new Error("Missing Google Chat access token");
  }
  return token;
}

const ENV_OAUTH_CLIENT_ID = "GOOGLE_CHAT_OAUTH_CLIENT_ID";
const ENV_OAUTH_CLIENT_SECRET = "GOOGLE_CHAT_OAUTH_CLIENT_SECRET";
const ENV_OAUTH_REDIRECT_URI = "GOOGLE_CHAT_OAUTH_REDIRECT_URI";
const ENV_OAUTH_CLIENT_FILE = "GOOGLE_CHAT_OAUTH_CLIENT_FILE";
const ENV_OAUTH_REFRESH_TOKEN = "GOOGLE_CHAT_OAUTH_REFRESH_TOKEN";
const ENV_OAUTH_REFRESH_TOKEN_FILE = "GOOGLE_CHAT_OAUTH_REFRESH_TOKEN_FILE";
const ENV_GOG_ACCOUNT = "GOG_ACCOUNT";
const ENV_GOG_CLIENT = "GOG_CLIENT";

type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

function parseOAuthClientJson(raw: unknown): OAuthClientConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const container =
    (record.web as Record<string, unknown> | undefined) ??
    (record.installed as Record<string, unknown> | undefined) ??
    record;
  const clientId = typeof container.client_id === "string" ? container.client_id.trim() : "";
  const clientSecret =
    typeof container.client_secret === "string" ? container.client_secret.trim() : "";
  const redirect =
    Array.isArray(container.redirect_uris) && typeof container.redirect_uris[0] === "string"
      ? container.redirect_uris[0].trim()
      : "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: redirect || undefined };
}

function resolveOAuthClientConfig(account: ResolvedGoogleChatAccount): OAuthClientConfig | null {
  const cfg = account.config;
  const gogAccount = cfg.gogAccount?.trim() || process.env[ENV_GOG_ACCOUNT]?.trim() || undefined;
  const gogClient = cfg.gogClient?.trim() || process.env[ENV_GOG_CLIENT]?.trim() || undefined;
  const inlineId = cfg.oauthClientId?.trim();
  const inlineSecret = cfg.oauthClientSecret?.trim();
  const inlineRedirect = cfg.oauthRedirectUri?.trim();
  if (inlineId && inlineSecret) {
    return {
      clientId: inlineId,
      clientSecret: inlineSecret,
      redirectUri: inlineRedirect || undefined,
    };
  }

  const filePath = cfg.oauthClientFile?.trim();
  if (filePath) {
    const parsed = parseOAuthClientJson(readJsonFile(filePath));
    if (parsed) return parsed;
  }

  if (cfg.oauthFromGog) {
    const gogCredentials = resolveGogCredentialsFile({ gogClient, gogAccount });
    if (gogCredentials) {
      const parsed = parseOAuthClientJson(readJsonFile(gogCredentials));
      if (parsed) return parsed;
    }
  }

  if (account.accountId === DEFAULT_ACCOUNT_ID) {
    const envId = process.env[ENV_OAUTH_CLIENT_ID]?.trim();
    const envSecret = process.env[ENV_OAUTH_CLIENT_SECRET]?.trim();
    const envRedirect = process.env[ENV_OAUTH_REDIRECT_URI]?.trim();
    if (envId && envSecret) {
      return { clientId: envId, clientSecret: envSecret, redirectUri: envRedirect || undefined };
    }
    const envFile = process.env[ENV_OAUTH_CLIENT_FILE]?.trim();
    if (envFile) {
      const parsed = parseOAuthClientJson(readJsonFile(envFile));
      if (parsed) return parsed;
    }
  }

  return null;
}

function resolveOAuthRefreshToken(account: ResolvedGoogleChatAccount): string | null {
  const cfg = account.config;
  const gogAccount = cfg.gogAccount?.trim() || process.env[ENV_GOG_ACCOUNT]?.trim() || undefined;
  const gogClient = cfg.gogClient?.trim() || process.env[ENV_GOG_CLIENT]?.trim() || undefined;
  if (cfg.oauthRefreshToken?.trim()) return cfg.oauthRefreshToken.trim();

  const tokenFile = cfg.oauthRefreshTokenFile?.trim();
  if (tokenFile) {
    const token = readRefreshTokenFromFile(tokenFile);
    if (token) return token;
  }

  if (cfg.oauthFromGog) {
    const token = readGogRefreshTokenSync({ gogAccount, gogClient });
    if (token) return token;
  }

  if (account.accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = process.env[ENV_OAUTH_REFRESH_TOKEN]?.trim();
    if (envToken) return envToken;
    const envFile = process.env[ENV_OAUTH_REFRESH_TOKEN_FILE]?.trim();
    if (envFile) {
      const token = readRefreshTokenFromFile(envFile);
      if (token) return token;
    }
  }
  return null;
}

function getOAuthClient(account: ResolvedGoogleChatAccount): OAuth2Client {
  const clientConfig = resolveOAuthClientConfig(account);
  const refreshToken = resolveOAuthRefreshToken(account);
  if (!clientConfig || !refreshToken) {
    throw new Error("Missing Google Chat OAuth client credentials or refresh token");
  }
  const key = `${clientConfig.clientId}:${clientConfig.clientSecret}:${clientConfig.redirectUri ?? ""}:${refreshToken}`;
  const cached = oauthCache.get(account.accountId);
  if (cached && cached.key === key) return cached.client;

  const client = new OAuth2Client(
    clientConfig.clientId,
    clientConfig.clientSecret,
    clientConfig.redirectUri,
  );
  client.setCredentials({ refresh_token: refreshToken });
  oauthCache.set(account.accountId, { key, client });
  return client;
}

export async function getGoogleChatUserAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const client = getOAuthClient(account);
  const access = await client.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) {
    throw new Error("Missing Google Chat OAuth access token");
  }
  return token;
}

async function fetchChatCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now - cachedCerts.fetchedAt < 10 * 60 * 1000) {
    return cachedCerts.certs;
  }
  const res = await fetch(CHAT_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Chat certs (${res.status})`);
  }
  const certs = (await res.json()) as Record<string, string>;
  cachedCerts = { fetchedAt: now, certs };
  return certs;
}

export type GoogleChatAudienceType = "app-url" | "project-number";

export type GoogleChatAuthMode = "auto" | "app" | "user";

export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
  options?: { mode?: GoogleChatAuthMode },
): Promise<string> {
  const mode = options?.mode ?? "auto";
  if (mode === "user") {
    return await getGoogleChatUserAccessToken(account);
  }
  if (mode === "app") {
    return await getGoogleChatAppAccessToken(account);
  }
  if (account.appCredentialSource !== "none") {
    return await getGoogleChatAppAccessToken(account);
  }
  return await getGoogleChatUserAccessToken(account);
}

export async function verifyGoogleChatRequest(params: {
  bearer?: string | null;
  audienceType?: GoogleChatAudienceType | null;
  audience?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const bearer = params.bearer?.trim();
  if (!bearer) return { ok: false, reason: "missing token" };
  const audience = params.audience?.trim();
  if (!audience) return { ok: false, reason: "missing audience" };
  const audienceType = params.audienceType ?? null;

  if (audienceType === "app-url") {
    try {
      const ticket = await verifyClient.verifyIdToken({
        idToken: bearer,
        audience,
      });
      const payload = ticket.getPayload();
      const email = payload?.email ?? "";
      const ok = payload?.email_verified && (email === CHAT_ISSUER || ADDON_ISSUER_PATTERN.test(email));
      return ok ? { ok: true } : { ok: false, reason: `invalid issuer: ${email}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  if (audienceType === "project-number") {
    try {
      const certs = await fetchChatCerts();
      await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  return { ok: false, reason: "unsupported audience type" };
}

export const GOOGLE_CHAT_SCOPE = CHAT_SCOPE;
