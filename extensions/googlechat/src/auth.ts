// Googlechat plugin module implements auth behavior.
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { getGoogleChatAdcAccessToken } from "./adc-token.js";
import {
  getGoogleAuthTransport,
  loadGoogleAuthRuntime,
  resolveAdcFileCredentials,
  resolveValidatedGoogleChatCredentials,
} from "./google-auth.runtime.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
// Cert fetch shares the same deadline as outbound API calls. Without a timeout,
// a stalled googleapis.com endpoint blocks webhook auth indefinitely, including
// cold-start and every 10-minute cache refresh.
const GOOGLECHAT_CERT_FETCH_TIMEOUT_MS = 30_000;

async function readGoogleChatCertsResponse(response: Response): Promise<Record<string, string>> {
  return readProviderJsonResponse<Record<string, string>>(
    response,
    "Google Chat cert fetch failed",
  );
}

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
type GoogleAuthRuntime = Awaited<ReturnType<typeof loadGoogleAuthRuntime>>;
type GoogleAuthInstance = InstanceType<GoogleAuthRuntime["GoogleAuth"]>;
type OAuth2ClientInstance = InstanceType<GoogleAuthRuntime["OAuth2Client"]>;

const authCache = new Map<string, { key: string; auth: GoogleAuthInstance }>();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;
let verifyClientPromise: Promise<OAuth2ClientInstance> | null = null;

async function getVerifyClient(): Promise<OAuth2ClientInstance> {
  if (!verifyClientPromise) {
    verifyClientPromise = (async () => {
      try {
        const { OAuth2Client } = await loadGoogleAuthRuntime();
        const transporter = await getGoogleAuthTransport();
        return new OAuth2Client({ transporter });
      } catch (error) {
        verifyClientPromise = null;
        throw error;
      }
    })();
  }
  return await verifyClientPromise;
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

async function getAuthInstance(
  account: ResolvedGoogleChatAccount,
  resolved?: { credentials: Record<string, unknown>; key: string },
): Promise<GoogleAuthInstance> {
  const key = resolved?.key ?? buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }
  const [{ GoogleAuth }, transporter, credentials] = await Promise.all([
    loadGoogleAuthRuntime(),
    getGoogleAuthTransport(),
    resolved
      ? Promise.resolve(resolved.credentials)
      : resolveValidatedGoogleChatCredentials(account),
  ]);

  const evictOldest = () => {
    if (authCache.size > MAX_AUTH_CACHE_SIZE) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) {
        authCache.delete(oldest);
      }
    }
  };

  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    clientOptions: { transporter },
    scopes: [CHAT_SCOPE],
  });
  authCache.set(account.accountId, { key, auth });
  evictOldest();
  return auth;
}

async function mintAccessToken(auth: GoogleAuthInstance): Promise<string> {
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) {
    throw new Error("Missing Google Chat access token");
  }
  return token;
}

export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  // Keyless (ADC) mode: resolve the ambient Application Default Credentials.
  // File/env sources (GOOGLE_APPLICATION_CREDENTIALS, the well-known gcloud
  // file) are minted via GoogleAuth over the guarded transporter; when only the
  // GCE metadata server is available we use the dedicated guarded mint
  // (adc-token.ts) rather than google-auth's unguarded gcp-metadata transport.
  if (account.credentialSource === "adc") {
    const adcCredentials = await resolveAdcFileCredentials();
    if (adcCredentials) {
      const auth = await getAuthInstance(account, {
        credentials: adcCredentials,
        key: `adc-file:${JSON.stringify(adcCredentials)}`,
      });
      return mintAccessToken(auth);
    }
    return getGoogleChatAdcAccessToken([CHAT_SCOPE]);
  }
  return mintAccessToken(await getAuthInstance(account));
}

async function fetchChatCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now - cachedCerts.fetchedAt < 10 * 60 * 1000) {
    return cachedCerts.certs;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: CHAT_CERTS_URL,
    auditContext: "googlechat.auth.certs",
    timeoutMs: GOOGLECHAT_CERT_FETCH_TIMEOUT_MS,
  });
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Failed to fetch Chat certs (${response.status})`);
    }
    const certs = await readGoogleChatCertsResponse(response);
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
      const verifyClient = await getVerifyClient();
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
      const verifyClient = await getVerifyClient();
      const certs = await fetchChatCerts();
      await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  return { ok: false, reason: "unsupported audience type" };
}
