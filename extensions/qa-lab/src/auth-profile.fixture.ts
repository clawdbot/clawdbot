import fs from "node:fs/promises";
import path from "node:path";

export const QA_CODEX_OAUTH_PROFILE_ID = "openai:qa-oauth";
export const QA_OPENAI_API_KEY_PROFILE_ID = "openai:media-api";
export const QA_AUTH_PROFILE_STORE_VERSION = 1;

export type QaAuthProfileShape = "oauth-only" | "apikey-only" | "mixed";

export type QaApiKeyAuthProfile = {
  type: "api_key";
  provider: "openai";
  key: string;
  displayName: string;
};

export type QaOAuthAuthProfile = {
  type: "oauth";
  provider: "openai";
  access: string;
  refresh: string;
  expires: number;
  email: string;
  displayName: string;
};

export type QaAuthProfile = QaApiKeyAuthProfile | QaOAuthAuthProfile;

export type QaAuthProfileSnapshot = {
  version: number;
  profiles: Record<string, QaAuthProfile>;
};

export type QaCodexAuthProfileSelection =
  | {
      status: "ready";
      profileId: string;
      provider: "openai";
      mode: "oauth";
    }
  | {
      status: "blocked";
      remediation: string;
    };

const QA_FIXED_OAUTH_EXPIRY_MS = Date.UTC(2036, 0, 1);

function authProfilesPath(agentDir: string) {
  return path.join(agentDir, "auth-profiles.json");
}

function buildCodexOAuthProfile(): QaOAuthAuthProfile {
  return {
    type: "oauth",
    provider: "openai",
    access: "qa-codex-oauth-access-placeholder",
    refresh: "qa-codex-oauth-refresh-placeholder",
    expires: QA_FIXED_OAUTH_EXPIRY_MS,
    email: "qa-codex@example.test",
    displayName: "QA Codex OAuth profile",
  };
}

function buildOpenAiApiKeyProfile(): QaApiKeyAuthProfile {
  return {
    type: "api_key",
    provider: "openai",
    key: "qa-openai-not-a-real-key",
    displayName: "QA OpenAI API-key profile",
  };
}

function buildProfileMap(shape: QaAuthProfileShape): Record<string, QaAuthProfile> {
  switch (shape) {
    case "oauth-only":
      return {
        [QA_CODEX_OAUTH_PROFILE_ID]: buildCodexOAuthProfile(),
      };
    case "apikey-only":
      return {
        [QA_OPENAI_API_KEY_PROFILE_ID]: buildOpenAiApiKeyProfile(),
      };
    case "mixed":
      return {
        [QA_CODEX_OAUTH_PROFILE_ID]: buildCodexOAuthProfile(),
        [QA_OPENAI_API_KEY_PROFILE_ID]: buildOpenAiApiKeyProfile(),
      };
  }
  const exhaustive: never = shape;
  return exhaustive;
}

function isQaAuthProfile(value: unknown): value is QaAuthProfile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.type === "oauth" && record.provider === "openai") ||
    (record.type === "api_key" && record.provider === "openai")
  );
}

function normalizeAuthProfileSnapshot(value: unknown): QaAuthProfileSnapshot {
  if (!value || typeof value !== "object") {
    return { version: QA_AUTH_PROFILE_STORE_VERSION, profiles: {} };
  }
  const record = value as Record<string, unknown>;
  const profilesRecord =
    record.profiles && typeof record.profiles === "object"
      ? (record.profiles as Record<string, unknown>)
      : {};
  const profiles = Object.fromEntries(
    Object.entries(profilesRecord)
      .filter((entry): entry is [string, QaAuthProfile] => isQaAuthProfile(entry[1]))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return {
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : QA_AUTH_PROFILE_STORE_VERSION,
    profiles,
  };
}

export async function seedAuthProfiles(
  shape: QaAuthProfileShape,
  agentDir: string,
): Promise<QaAuthProfileSnapshot> {
  const snapshot = {
    version: QA_AUTH_PROFILE_STORE_VERSION,
    profiles: buildProfileMap(shape),
  };
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(authProfilesPath(agentDir), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export async function snapshotAuthProfiles(agentDir: string): Promise<QaAuthProfileSnapshot> {
  const raw = await fs.readFile(authProfilesPath(agentDir), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!raw) {
    return { version: QA_AUTH_PROFILE_STORE_VERSION, profiles: {} };
  }
  return normalizeAuthProfileSnapshot(JSON.parse(raw) as unknown);
}

export function resolveCodexAuthProfile(
  snapshot: QaAuthProfileSnapshot,
): QaCodexAuthProfileSelection {
  const profileId = Object.keys(snapshot.profiles)
    .toSorted((left, right) => left.localeCompare(right))
    .find((candidate) => {
      const profile = snapshot.profiles[candidate];
      return profile?.type === "oauth" && profile.provider === "openai";
    });

  if (!profileId) {
    return {
      status: "blocked",
      remediation:
        'Codex app-server auth requires an openai OAuth profile. Run "openclaw doctor --fix" to repair Codex auth routing before retrying.',
    };
  }

  return {
    status: "ready",
    profileId,
    provider: "openai",
    mode: "oauth",
  };
}
