import { GoogleAuth, OAuth2Client } from "google-auth-library";

import type { ResolvedGoogleChatAccount } from "./accounts.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
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

export async function getGoogleChatAccessToken(
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
