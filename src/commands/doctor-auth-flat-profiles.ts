import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentDir, listAgentIds } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadJsonFile } from "../infra/json-file.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type AuthProfileRepairCandidate = {
  agentDir?: string;
  authPath: string;
};

type LegacyFlatAuthProfileStore = {
  agentDir?: string;
  authPath: string;
  store: AuthProfileStore;
};

type AwsSdkProfileMarker = {
  profileId: string;
  provider: string;
  email?: string;
  displayName?: string;
};

type AwsSdkAuthProfileMarkerStore = {
  agentDir?: string;
  authPath: string;
  raw: Record<string, unknown>;
  profiles: AwsSdkProfileMarker[];
};

export type LegacyFlatAuthProfileRepairResult = {
  detected: string[];
  changes: string[];
  warnings: string[];
};

const UNSAFE_LEGACY_AUTH_PROFILE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isSafeLegacyProviderKey(key: string): boolean {
  return key.trim().length > 0 && !UNSAFE_LEGACY_AUTH_PROFILE_KEYS.has(key);
}

function extractProviderFromProfileId(profileId: string): string | undefined {
  const colon = profileId.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return readNonEmptyString(profileId.slice(0, colon));
}

function inferLegacyCredentialType(
  record: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) {
    return "api_key";
  }
  if (readNonEmptyString(record.token)) {
    return "token";
  }
  if (
    readNonEmptyString(record.access) &&
    readNonEmptyString(record.refresh) &&
    typeof record.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

function coerceLegacyFlatCredential(
  providerId: string,
  raw: unknown,
): AuthProfileCredential | null {
  if (!isRecord(raw)) {
    return null;
  }
  const provider = readNonEmptyString(raw.provider) ?? providerId;
  const type = inferLegacyCredentialType(raw);
  const email = readNonEmptyString(raw.email);
  if (type === "api_key") {
    const key = readNonEmptyString(raw.key) ?? readNonEmptyString(raw.apiKey);
    return key ? { type, provider, key, ...(email ? { email } : {}) } : null;
  }
  if (type === "token") {
    const token = readNonEmptyString(raw.token);
    return token
      ? {
          type,
          provider,
          token,
          ...(typeof raw.expires === "number" ? { expires: raw.expires } : {}),
          ...(email ? { email } : {}),
        }
      : null;
  }
  if (type === "oauth") {
    const access = readNonEmptyString(raw.access);
    const refresh = readNonEmptyString(raw.refresh);
    if (!access || !refresh || typeof raw.expires !== "number") {
      return null;
    }
    return {
      type,
      provider,
      access,
      refresh,
      expires: raw.expires,
      ...(readNonEmptyString(raw.enterpriseUrl)
        ? { enterpriseUrl: readNonEmptyString(raw.enterpriseUrl) }
        : {}),
      ...(readNonEmptyString(raw.projectId)
        ? { projectId: readNonEmptyString(raw.projectId) }
        : {}),
      ...(readNonEmptyString(raw.accountId)
        ? { accountId: readNonEmptyString(raw.accountId) }
        : {}),
      ...(email ? { email } : {}),
    };
  }
  return null;
}

function coerceLegacyFlatAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw) || "profiles" in raw) {
    return null;
  }
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  for (const [key, value] of Object.entries(raw)) {
    const providerId = key.trim();
    if (!isSafeLegacyProviderKey(providerId)) {
      continue;
    }
    const credential = coerceLegacyFlatCredential(providerId, value);
    if (!credential) {
      continue;
    }
    store.profiles[`${providerId}:default`] = credential;
  }
  return Object.keys(store.profiles).length > 0 ? store : null;
}

function addCandidate(
  candidates: Map<string, AuthProfileRepairCandidate>,
  agentDir: string | undefined,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  candidates.set(path.resolve(authPath), { agentDir, authPath });
}

function listExistingAgentDirsFromState(): string[] {
  const root = path.join(resolveStateDir(), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "agent"))
    .filter((agentDir) => {
      try {
        return fs.statSync(agentDir).isDirectory();
      } catch {
        return false;
      }
    });
}

function listAuthProfileRepairCandidates(cfg: OpenClawConfig): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  addCandidate(candidates, resolveDefaultAgentDir(cfg));
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(candidates, resolveAgentDir(cfg, agentId));
  }
  for (const agentDir of listExistingAgentDirsFromState()) {
    addCandidate(candidates, agentDir);
  }
  return [...candidates.values()];
}

function resolveLegacyFlatStore(
  candidate: AuthProfileRepairCandidate,
): LegacyFlatAuthProfileStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!raw || typeof raw !== "object" || "profiles" in raw) {
    return null;
  }
  const store = coerceLegacyFlatAuthProfileStore(raw);
  if (!store || Object.keys(store.profiles).length === 0) {
    return null;
  }
  return {
    ...candidate,
    store,
  };
}

function backupAuthProfileStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.legacy-flat.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

function backupAwsSdkProfileMarkerStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.aws-sdk-profile.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

function resolveAwsSdkAuthProfileMarkerStore(
  candidate: AuthProfileRepairCandidate,
): AwsSdkAuthProfileMarkerStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const markers: AwsSdkProfileMarker[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value)) {
      continue;
    }
    const mode = readNonEmptyString(value.type) ?? readNonEmptyString(value.mode);
    if (mode !== "aws-sdk") {
      continue;
    }
    const provider = readNonEmptyString(value.provider) ?? extractProviderFromProfileId(profileId);
    if (!provider || !isSafeLegacyProviderKey(provider)) {
      continue;
    }
    markers.push({
      profileId,
      provider,
      ...(readNonEmptyString(value.email) ? { email: readNonEmptyString(value.email) } : {}),
      ...(readNonEmptyString(value.displayName)
        ? { displayName: readNonEmptyString(value.displayName) }
        : {}),
    });
  }
  return markers.length > 0
    ? {
        ...candidate,
        raw,
        profiles: markers,
      }
    : null;
}

function ensureConfigAuthProfiles(config: OpenClawConfig): Record<string, AuthProfileConfig> {
  const root = config as Record<string, unknown>;
  const auth = isRecord(root.auth) ? root.auth : {};
  if (root.auth !== auth) {
    root.auth = auth;
  }
  if (!isRecord(auth.profiles)) {
    auth.profiles = {};
  }
  return auth.profiles as Record<string, AuthProfileConfig>;
}

function removeAwsSdkProfileMarkers(raw: Record<string, unknown>, profileIds: string[]): void {
  if (!isRecord(raw.profiles)) {
    return;
  }
  for (const profileId of profileIds) {
    delete raw.profiles[profileId];
  }
}

export async function maybeRepairLegacyFlatAuthProfileStores(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  now?: () => number;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const legacyStores = listAuthProfileRepairCandidates(params.cfg)
    .map(resolveLegacyFlatStore)
    .filter((entry): entry is LegacyFlatAuthProfileStore => entry !== null);
  const awsSdkMarkerStores = listAuthProfileRepairCandidates(params.cfg)
    .map(resolveAwsSdkAuthProfileMarkerStore)
    .filter((entry): entry is AwsSdkAuthProfileMarkerStore => entry !== null);

  const result: LegacyFlatAuthProfileRepairResult = {
    detected: [
      ...legacyStores.map((entry) => entry.authPath),
      ...awsSdkMarkerStores.map((entry) => entry.authPath),
    ],
    changes: [],
    warnings: [],
  };
  if (legacyStores.length === 0 && awsSdkMarkerStores.length === 0) {
    return result;
  }

  const noteLines = [
    ...legacyStores.map(
      (entry) => `- ${shortenHomePath(entry.authPath)} uses the legacy flat auth profile format.`,
    ),
    ...awsSdkMarkerStores.map(
      (entry) =>
        `- ${shortenHomePath(entry.authPath)} contains aws-sdk profile markers that belong in openclaw.json auth.profiles.`,
    ),
  ];
  if (legacyStores.length > 0) {
    noteLines.push(
      `- The gateway expects the canonical version/profiles store; ${formatCliCommand("openclaw doctor --fix")} rewrites this legacy shape with a backup.`,
    );
  }
  if (awsSdkMarkerStores.length > 0) {
    noteLines.push(
      `- AWS SDK profile markers are routing metadata, not stored credentials; ${formatCliCommand("openclaw doctor --fix")} moves them to config with a backup.`,
    );
  }
  note(noteLines.join("\n"), "Auth profiles");

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Repair legacy auth-profiles.json files now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }

  for (const entry of legacyStores) {
    try {
      const backupPath = backupAuthProfileStore(entry.authPath, now);
      saveAuthProfileStore(entry.store, entry.agentDir, { syncExternalCli: false });
      result.changes.push(
        `Rewrote ${shortenHomePath(entry.authPath)} to the canonical auth profile format (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(`Failed to rewrite ${shortenHomePath(entry.authPath)}: ${String(err)}`);
    }
  }
  for (const entry of awsSdkMarkerStores) {
    try {
      const backupPath = backupAwsSdkProfileMarkerStore(entry.authPath, now);
      const configProfiles = ensureConfigAuthProfiles(params.cfg);
      for (const marker of entry.profiles) {
        configProfiles[marker.profileId] = {
          provider: marker.provider,
          mode: "aws-sdk",
          ...(marker.email ? { email: marker.email } : {}),
          ...(marker.displayName ? { displayName: marker.displayName } : {}),
        };
      }
      removeAwsSdkProfileMarkers(
        entry.raw,
        entry.profiles.map((profile) => profile.profileId),
      );
      fs.writeFileSync(entry.authPath, `${JSON.stringify(entry.raw, null, 2)}\n`);
      result.changes.push(
        `Moved aws-sdk profile metadata from ${shortenHomePath(entry.authPath)} to auth.profiles (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(
        `Failed to migrate aws-sdk profile markers from ${shortenHomePath(entry.authPath)}: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  if (result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}
