import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getZalouserRuntime } from "./runtime.js";
import type { Credentials } from "./zca-client.js";

export type StoredZaloCredentials = {
  profile: string;
  imei: string;
  cookie: Credentials["cookie"];
  userAgent: string;
  language?: string;
  createdAt: string;
  lastUsedAt?: string;
};

type ZaloCredentialRevocationRecord = {
  kind: "revoked";
  profile: string;
  revokedAt: string;
};

export type ZaloCredentialStateRecord = StoredZaloCredentials | ZaloCredentialRevocationRecord;

export const ZALOUSER_CREDENTIALS_NAMESPACE = "credentials";
export const ZALOUSER_CREDENTIALS_MAX_ENTRIES = 256;

export function normalizeZalouserCredentialProfile(profile?: string | null): string {
  return normalizeLowercaseStringOrEmpty(profile) || "default";
}

export function zalouserCredentialStoreKey(profile?: string | null): string {
  return `profile:${createHash("sha256")
    .update(normalizeZalouserCredentialProfile(profile))
    .digest("hex")}`;
}

export function resolveLegacyZalouserCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env, os.homedir), "credentials", "zalouser");
}

export function resolveLegacyZalouserCredentialsPath(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeZalouserCredentialProfile(profile);
  const filename =
    normalized === "default"
      ? "credentials.json"
      : `credentials-${encodeURIComponent(normalized)}.json`;
  return path.join(resolveLegacyZalouserCredentialsDir(env), filename);
}

export function normalizeStoredZaloCredentials(
  value: unknown,
  profile?: string | null,
): StoredZaloCredentials | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<StoredZaloCredentials>;
  if (
    typeof parsed.imei !== "string" ||
    !parsed.imei ||
    !parsed.cookie ||
    typeof parsed.userAgent !== "string" ||
    !parsed.userAgent ||
    typeof parsed.createdAt !== "string" ||
    !parsed.createdAt
  ) {
    return null;
  }
  return {
    profile: normalizeZalouserCredentialProfile(profile ?? parsed.profile),
    imei: parsed.imei,
    cookie: parsed.cookie,
    userAgent: parsed.userAgent,
    ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
    createdAt: parsed.createdAt,
    ...(typeof parsed.lastUsedAt === "string" ? { lastUsedAt: parsed.lastUsedAt } : {}),
  };
}

export function isZaloCredentialRevocation(
  value: unknown,
  profile?: string | null,
): value is ZaloCredentialRevocationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const parsed = value as Partial<ZaloCredentialRevocationRecord>;
  return (
    parsed.kind === "revoked" &&
    typeof parsed.revokedAt === "string" &&
    parsed.revokedAt.length > 0 &&
    normalizeZalouserCredentialProfile(parsed.profile) ===
      normalizeZalouserCredentialProfile(profile ?? parsed.profile)
  );
}

function openZalouserCredentialsStore(
  env: NodeJS.ProcessEnv = process.env,
): PluginStateSyncKeyedStore<ZaloCredentialStateRecord> {
  return getZalouserRuntime().state.openSyncKeyedStore<ZaloCredentialStateRecord>({
    namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
    maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
}

export function loadStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredZaloCredentials | null {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const stored = openZalouserCredentialsStore(env).lookup(
    zalouserCredentialStoreKey(normalizedProfile),
  );
  const parsed = normalizeStoredZaloCredentials(stored, normalizedProfile);
  return parsed?.profile === normalizedProfile ? parsed : null;
}

export function saveStoredZaloCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  openZalouserCredentialsStore(env).register(zalouserCredentialStoreKey(normalizedProfile), {
    profile: normalizedProfile,
    ...credentials,
  });
}

export function refreshStoredZaloCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const store = openZalouserCredentialsStore(env);
  const update = store.update;
  if (!update) {
    throw new Error("Zalo credential refresh requires atomic plugin-state updates");
  }
  let saved = true;
  update(zalouserCredentialStoreKey(normalizedProfile), (current) => {
    // Background refreshes can finish after logout. Preserve the revocation;
    // only an explicit QR login may replace it with a new authenticated session.
    if (isZaloCredentialRevocation(current, normalizedProfile)) {
      saved = false;
      return current;
    }
    return { profile: normalizedProfile, ...credentials };
  });
  return saved;
}

export function clearStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const store = openZalouserCredentialsStore(env);
  const hadCredentials =
    normalizeStoredZaloCredentials(
      store.lookup(zalouserCredentialStoreKey(normalizedProfile)),
      normalizedProfile,
    ) !== null;
  // Keep a durable revocation marker so doctor cannot resurrect explicitly
  // cleared credentials from an older profile file.
  store.register(zalouserCredentialStoreKey(normalizedProfile), {
    kind: "revoked",
    profile: normalizedProfile,
    revokedAt: new Date().toISOString(),
  });
  return hadCredentials;
}
