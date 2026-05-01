import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  __testing as googleAuthRuntimeTesting,
  getGoogleAuthTransport,
  loadGoogleAuthRuntime,
  resolveValidatedGoogleChatCredentials,
} from "./google-auth.runtime.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
type GoogleAuthModule = typeof import("google-auth-library");
type GoogleAuthRuntime = {
  GoogleAuth: GoogleAuthModule["GoogleAuth"];
  OAuth2Client: GoogleAuthModule["OAuth2Client"];
};
type GoogleAuthInstance = InstanceType<GoogleAuthRuntime["GoogleAuth"]>;
type GoogleAuthOptions = ConstructorParameters<GoogleAuthRuntime["GoogleAuth"]>[0];
type GoogleAuthTransport = NonNullable<GoogleAuthOptions>["clientOptions"] extends {
  transporter?: infer T;
}
  ? T
  : never;
type OAuth2ClientInstance = InstanceType<GoogleAuthRuntime["OAuth2Client"]>;

const authCache = new Map<string, { key: string; auth: GoogleAuthInstance }>();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;
let verifyClientPromise: Promise<OAuth2ClientInstance> | null = null;

async function getVerifyClient(): Promise<OAuth2ClientInstance> {
  if (!verifyClientPromise) {
    verifyClientPromise = (async () => {
      try {
        const { OAuth2Client } = await loadGoogleAuthRuntime();
        // google-auth-library types its transporter through gaxios' CJS surface,
        // while the plugin imports the ESM entrypoint directly.
        const transporter = (await getGoogleAuthTransport()) as unknown as GoogleAuthTransport;
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

async function getAuthInstance(account: ResolvedGoogleChatAccount): Promise<GoogleAuthInstance> {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }
  const [{ GoogleAuth }, rawTransporter, credentials] = await Promise.all([
    loadGoogleAuthRuntime(),
    getGoogleAuthTransport(),
    resolveValidatedGoogleChatCredentials(account),
  ]);
  const transporter = rawTransporter as unknown as GoogleAuthTransport;

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

export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const auth = await getAuthInstance(account);
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

export const __testing = {
  resetGoogleChatAuthForTests(): void {
    authCache.clear();
    cachedCerts = null;
    verifyClientPromise = null;
    googleAuthRuntimeTesting.resetGoogleAuthRuntimeForTests();
  },
};
