import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
const verifyClient = new OAuth2Client();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildAuthKey(account: ResolvedGoogleChatAccount): string {
  if (account.credentialsFile) {
    return `file:${account.credentialsFile}`;
  }
  if (account.credentials) {
    return `inline:${JSON.stringify(account.credentials)}`;
  }
  return "none";
}

function getAuthInstance(account: ResolvedGoogleChatAccount): GoogleAuth {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }

  const evictOldest = () => {
    if (authCache.size > MAX_AUTH_CACHE_SIZE) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) {
        authCache.delete(oldest);
      }
    }
  };

  if (account.credentialsFile) {
    const auth = new GoogleAuth({ keyFile: account.credentialsFile, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  if (account.credentials) {
    const auth = new GoogleAuth({ credentials: account.credentials, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] });
  authCache.set(account.accountId, { key, auth });
  evictOldest();
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
  const { response, release } = await fetchWithSsrFGuard({
    url: CHAT_CERTS_URL,
    auditContext: "googlechat.auth.certs",
  });
  try {
    if (!response.ok) {
      throw new Error(`Failed to fetch Chat certs (${response.status})`);
    }
    const certs = (await response.json()) as Record<string, string>;
    cachedCerts = { fetchedAt: now, certs };
    return certs;
  } finally {
    await release();
  }
}

export type GoogleChatAudienceType = "app-url" | "project-number";

export async function verifyGoogleChatRequest(params: {
  bearer?: string | null;
  audienceType?: GoogleChatAudienceType | null;
  audience?: string | null;
  expectedAddOnPrincipal?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const bearer = params.bearer?.trim();
  if (!bearer) {
    return { ok: false, reason: "missing token" };
  }
  const audience = params.audience?.trim();
  if (!audience) {
    return { ok: false, reason: "missing audience" };
  }
  const audienceType = params.audienceType ?? null;

  if (audienceType === "app-url") {
    try {
      const ticket = await verifyClient.verifyIdToken({
        idToken: bearer,
        audience,
      });
      const payload = ticket.getPayload();
      const email = normalizeLowercaseStringOrEmpty(payload?.email ?? "");
      if (!payload?.email_verified) {
        return { ok: false, reason: "email not verified" };
      }
      if (email === CHAT_ISSUER) {
        return { ok: true };
      }
      if (!ADDON_ISSUER_PATTERN.test(email)) {
        return { ok: false, reason: `invalid issuer: ${email}` };
      }
      const expectedAddOnPrincipal = normalizeLowercaseStringOrEmpty(
        params.expectedAddOnPrincipal ?? "",
      );
      if (!expectedAddOnPrincipal) {
        return { ok: false, reason: "missing add-on principal binding" };
      }
      const tokenPrincipal = normalizeLowercaseStringOrEmpty(payload?.sub ?? "");
      if (!tokenPrincipal || tokenPrincipal !== expectedAddOnPrincipal) {
        return {
          ok: false,
          reason: `unexpected add-on principal: ${tokenPrincipal || "<missing>"}`,
        };
      }
      return { ok: true };
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
