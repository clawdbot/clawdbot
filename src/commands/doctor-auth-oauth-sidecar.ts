import * as childProcess from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
const LEGACY_OAUTH_SECRET_VERSION = 1;
const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
const LEGACY_OAUTH_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const LEGACY_OAUTH_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";

type AuthProfileRepairCandidate = {
  agentDir?: string;
  authPath: string;
};

type LegacyOAuthRef = {
  source: typeof LEGACY_OAUTH_REF_SOURCE;
  provider: typeof LEGACY_OAUTH_REF_PROVIDER;
  id: string;
};

type LegacyOAuthSidecarProfile = {
  profileId: string;
  provider: string;
  ref: LegacyOAuthRef;
};

type LegacyOAuthSidecarStore = AuthProfileRepairCandidate & {
  raw: Record<string, unknown>;
  profiles: LegacyOAuthSidecarProfile[];
};

type LegacyOAuthUnreferencedSidecar = {
  sidecarPath: string;
};

type LegacyOAuthSecretMaterial = {
  access?: string;
  refresh?: string;
  idToken?: string;
};

type LegacyOAuthEncryptedPayload = {
  algorithm: typeof LEGACY_OAUTH_SECRET_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type LegacyOAuthSidecarRepairResult = {
  detected: string[];
  changes: string[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isLegacyOAuthRef(value: unknown): value is LegacyOAuthRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.source === LEGACY_OAUTH_REF_SOURCE &&
    value.provider === LEGACY_OAUTH_REF_PROVIDER &&
    typeof value.id === "string" &&
    /^[a-f0-9]{32}$/.test(value.id)
  );
}

function addCandidate(
  candidates: Map<string, AuthProfileRepairCandidate>,
  agentDir: string | undefined,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  candidates.set(path.resolve(authPath), { agentDir, authPath });
}

function listExistingAgentDirsFromState(env: NodeJS.ProcessEnv): string[] {
  const root = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name, "agent"))
    .filter((agentDir) => {
      try {
        return fs.statSync(agentDir).isDirectory();
      } catch {
        return false;
      }
    });
}

function listAuthProfileRepairCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  addCandidate(candidates, resolveDefaultAgentDir(cfg, env));
  const envAgentDir = readNonEmptyString(env.OPENCLAW_AGENT_DIR);
  if (envAgentDir) {
    addCandidate(candidates, envAgentDir);
  }
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(candidates, resolveAgentDir(cfg, agentId, env));
  }
  for (const agentDir of listExistingAgentDirsFromState(env)) {
    addCandidate(candidates, agentDir);
  }
  return [...candidates.values()];
}

function resolveLegacyOAuthSidecarStore(
  candidate: AuthProfileRepairCandidate,
): LegacyOAuthSidecarStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const profiles: LegacyOAuthSidecarProfile[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value) || value.type !== "oauth") {
      continue;
    }
    const ref = isLegacyOAuthRef(value.oauthRef) ? value.oauthRef : undefined;
    const provider = readNonEmptyString(value.provider);
    if (!ref || provider !== LEGACY_OAUTH_REF_PROVIDER) {
      continue;
    }
    profiles.push({ profileId, provider, ref });
  }
  return profiles.length > 0
    ? {
        ...candidate,
        raw,
        profiles,
      }
    : null;
}

function resolveLegacyOAuthSidecarPath(
  ref: LegacyOAuthRef,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME, `${ref.id}.json`);
}

function normalizeLegacyOAuthSecretMaterial(raw: unknown): LegacyOAuthSecretMaterial | null {
  if (!isRecord(raw)) {
    return null;
  }
  const material: LegacyOAuthSecretMaterial = {
    ...(readNonEmptyString(raw.access) ? { access: readNonEmptyString(raw.access) } : {}),
    ...(readNonEmptyString(raw.refresh) ? { refresh: readNonEmptyString(raw.refresh) } : {}),
    ...(readNonEmptyString(raw.idToken) ? { idToken: readNonEmptyString(raw.idToken) } : {}),
  };
  return Object.keys(material).length > 0 ? material : null;
}

function coerceLegacyOAuthEncryptedPayload(raw: unknown): LegacyOAuthEncryptedPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  return raw.algorithm === LEGACY_OAUTH_SECRET_ALGORITHM &&
    typeof raw.iv === "string" &&
    typeof raw.tag === "string" &&
    typeof raw.ciphertext === "string"
    ? {
        algorithm: raw.algorithm,
        iv: raw.iv,
        tag: raw.tag,
        ciphertext: raw.ciphertext,
      }
    : null;
}

function isLegacyOAuthSidecarPayload(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if (
    raw.version !== LEGACY_OAUTH_SECRET_VERSION ||
    readNonEmptyString(raw.profileId) === undefined ||
    raw.provider !== LEGACY_OAUTH_REF_PROVIDER
  ) {
    return false;
  }
  return (
    coerceLegacyOAuthEncryptedPayload(raw.encrypted) !== null ||
    normalizeLegacyOAuthSecretMaterial(raw) !== null
  );
}

function listUnreferencedLegacyOAuthSidecars(
  referencedRefIds: Set<string>,
  env: NodeJS.ProcessEnv,
): LegacyOAuthUnreferencedSidecar[] {
  const sidecarDir = path.join(resolveOAuthDir(env), LEGACY_OAUTH_SECRET_DIRNAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sidecarDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      return [];
    }
    const refId = entry.name.slice(0, -".json".length);
    if (!/^[a-f0-9]{32}$/.test(refId) || referencedRefIds.has(refId)) {
      return [];
    }
    const sidecarPath = path.join(sidecarDir, entry.name);
    return isLegacyOAuthSidecarPayload(loadJsonFile(sidecarPath)) ? [{ sidecarPath }] : [];
  });
}

function buildLegacyOAuthSecretAad(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
}): Buffer {
  return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}

function buildLegacyOAuthSecretKey(seed: string): Buffer {
  return createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest();
}

function isPathInsideOrEqual(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((entry): entry is string => Boolean(entry))));
}

function resolveLegacyOAuthSecretKeyFileCandidates(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") {
    const home = env.USERPROFILE?.trim() || os.homedir();
    const root = env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : undefined);
    return uniquePaths([
      root ? path.join(root, "OpenClaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }

  if (process.platform === "darwin") {
    const home = env.HOME?.trim() || os.homedir();
    return uniquePaths([
      home
        ? path.join(
            home,
            "Library",
            "Application Support",
            "OpenClaw",
            LEGACY_OAUTH_SECRET_KEY_FILE_NAME,
          )
        : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }

  const home = env.HOME?.trim() || os.homedir();
  const root = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
  return uniquePaths([
    root ? path.join(root, "openclaw", LEGACY_OAUTH_SECRET_KEY_FILE_NAME) : undefined,
    home
      ? path.join(home, ".openclaw-auth-profile-secrets", LEGACY_OAUTH_SECRET_KEY_FILE_NAME)
      : undefined,
  ]);
}

function resolveLegacyOAuthSecretKeyFilePath(env: NodeJS.ProcessEnv): string | undefined {
  const stateDir = resolveStateDir(env);
  return resolveLegacyOAuthSecretKeyFileCandidates(env).find(
    (candidate) => !isPathInsideOrEqual(stateDir, candidate),
  );
}

function readLegacyOAuthSecretKeyFile(env: NodeJS.ProcessEnv): string | undefined {
  const keyPath = resolveLegacyOAuthSecretKeyFilePath(env);
  if (!keyPath) {
    return undefined;
  }
  try {
    const value = fs.readFileSync(keyPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readLegacyMacOAuthSecretKeychainKey(): string | undefined {
  if (
    process.platform !== "darwin" ||
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined
  ) {
    return undefined;
  }
  try {
    // Legacy removal-only migration for #79006 sidecar OAuth profiles.
    // Do not add or normalize any OS-level Keychain integrations in OpenClaw.
    // Keychain access here exists only so doctor can move affected users back
    // to the canonical inline auth-profiles.json OAuth credential shape.
    return childProcess
      .execFileSync(
        "security",
        [
          "find-generic-password",
          "-s",
          LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE,
          "-a",
          LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT,
          "-w",
        ],
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      )
      .trim();
  } catch {
    return undefined;
  }
}

function resolveLegacyOAuthSecretKeySeeds(env: NodeJS.ProcessEnv): string[] {
  const seeds: string[] = [];
  const addSeed = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && !seeds.includes(trimmed)) {
      seeds.push(trimmed);
    }
  };
  addSeed(env[LEGACY_OAUTH_SECRET_KEY_ENV]);
  if (env.NODE_ENV === "test" && env.VITEST === "true") {
    addSeed("openclaw-test-oauth-profile-secret-key");
  }
  addSeed(readLegacyOAuthSecretKeyFile(env));
  return seeds;
}

function decryptLegacyOAuthSecretMaterialWithSeed(
  params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
    encrypted: LegacyOAuthEncryptedPayload;
  },
  seed: string,
): LegacyOAuthSecretMaterial | null {
  try {
    const decipher = createDecipheriv(
      LEGACY_OAUTH_SECRET_ALGORITHM,
      buildLegacyOAuthSecretKey(seed),
      Buffer.from(params.encrypted.iv, "base64url"),
    );
    decipher.setAAD(
      buildLegacyOAuthSecretAad({
        ref: params.ref,
        profileId: params.profileId,
        provider: params.provider,
      }),
    );
    decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return normalizeLegacyOAuthSecretMaterial(JSON.parse(plaintext) as unknown);
  } catch {
    return null;
  }
}

function decryptLegacyOAuthSecretMaterial(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
  encrypted: LegacyOAuthEncryptedPayload;
  env: NodeJS.ProcessEnv;
}): LegacyOAuthSecretMaterial | null {
  const seeds = resolveLegacyOAuthSecretKeySeeds(params.env);
  for (const seed of seeds) {
    const material = decryptLegacyOAuthSecretMaterialWithSeed(params, seed);
    if (material) {
      return material;
    }
  }
  const keychainSeed = readLegacyMacOAuthSecretKeychainKey();
  if (keychainSeed && !seeds.includes(keychainSeed)) {
    return decryptLegacyOAuthSecretMaterialWithSeed(params, keychainSeed);
  }
  return null;
}

function loadLegacyOAuthSidecarMaterial(
  profile: LegacyOAuthSidecarProfile,
  env: NodeJS.ProcessEnv,
): LegacyOAuthSecretMaterial | null {
  const raw = loadJsonFile(resolveLegacyOAuthSidecarPath(profile.ref, env));
  if (!isRecord(raw)) {
    return null;
  }
  if (
    raw.version !== LEGACY_OAUTH_SECRET_VERSION ||
    raw.profileId !== profile.profileId ||
    raw.provider !== profile.provider
  ) {
    return null;
  }
  const encrypted = coerceLegacyOAuthEncryptedPayload(raw.encrypted);
  if (encrypted) {
    return decryptLegacyOAuthSecretMaterial({
      ref: profile.ref,
      profileId: profile.profileId,
      provider: profile.provider,
      encrypted,
      env,
    });
  }
  return normalizeLegacyOAuthSecretMaterial(raw);
}

function applyLegacyOAuthSidecarMaterial(params: {
  raw: Record<string, unknown>;
  profile: LegacyOAuthSidecarProfile;
  material: LegacyOAuthSecretMaterial;
}): boolean {
  if (!isRecord(params.raw.profiles)) {
    return false;
  }
  const entry = params.raw.profiles[params.profile.profileId];
  if (!isRecord(entry)) {
    return false;
  }
  delete entry.oauthRef;
  if (params.material.access) {
    entry.access = params.material.access;
  }
  if (params.material.refresh) {
    entry.refresh = params.material.refresh;
  }
  if (params.material.idToken) {
    entry.idToken = params.material.idToken;
  }
  return true;
}

function backupLegacyOAuthSidecarStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.oauth-ref.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

export async function maybeRepairLegacyOAuthSidecarProfiles(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix">;
  now?: () => number;
  emitNotes?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyOAuthSidecarRepairResult> {
  const now = params.now ?? Date.now;
  const emitNotes = params.emitNotes !== false;
  const env = params.env ?? process.env;
  const stores = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveLegacyOAuthSidecarStore)
    .filter((entry): entry is LegacyOAuthSidecarStore => entry !== null);
  const referencedRefIds = new Set(stores.flatMap((entry) => entry.profiles.map((p) => p.ref.id)));
  const unreferencedSidecars = listUnreferencedLegacyOAuthSidecars(referencedRefIds, env);

  const result: LegacyOAuthSidecarRepairResult = {
    detected: [
      ...stores.map((entry) => entry.authPath),
      ...unreferencedSidecars.map((entry) => entry.sidecarPath),
    ],
    changes: [],
    warnings: [],
  };
  if (stores.length === 0 && unreferencedSidecars.length === 0) {
    return result;
  }

  if (emitNotes) {
    note(
      [
        ...stores.map(
          (entry) =>
            `- ${shortenHomePath(entry.authPath)} has legacy sidecar-backed Codex OAuth profiles.`,
        ),
        ...(unreferencedSidecars.length > 0
          ? [
              `- Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}.`,
              `- Unreferenced sidecar files are left in place because external agent directories outside this scan may still reference them.`,
            ]
          : []),
        `- ${formatCliCommand("openclaw doctor --fix")} migrates active profiles back to inline OAuth credentials and removes only sidecar files it successfully migrated.`,
      ].join("\n"),
      "Auth profiles",
    );
  }

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Migrate legacy sidecar-backed Codex OAuth credentials now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }

  const migratedSidecarsByRefId = new Map<string, string>();
  const unresolvedRefIds = new Set<string>();
  for (const store of stores) {
    let migratedCount = 0;
    const storeMigratedSidecarsByRefId = new Map<string, string>();
    for (const profile of store.profiles) {
      const material = loadLegacyOAuthSidecarMaterial(profile, env);
      if (!material) {
        unresolvedRefIds.add(profile.ref.id);
        result.warnings.push(
          `Could not decrypt legacy OAuth sidecar for ${profile.profileId} in ${shortenHomePath(store.authPath)}; re-authenticate this profile.`,
        );
        continue;
      }
      if (applyLegacyOAuthSidecarMaterial({ raw: store.raw, profile, material })) {
        migratedCount += 1;
        storeMigratedSidecarsByRefId.set(
          profile.ref.id,
          resolveLegacyOAuthSidecarPath(profile.ref, env),
        );
      } else {
        unresolvedRefIds.add(profile.ref.id);
      }
    }

    if (migratedCount === 0) {
      continue;
    }

    try {
      const backupPath = backupLegacyOAuthSidecarStore(store.authPath, now);
      if (!("version" in store.raw)) {
        store.raw.version = AUTH_STORE_VERSION;
      }
      saveJsonFile(store.authPath, store.raw);
      for (const [refId, sidecarPath] of storeMigratedSidecarsByRefId) {
        migratedSidecarsByRefId.set(refId, sidecarPath);
      }
      result.changes.push(
        `Migrated ${migratedCount} sidecar-backed Codex OAuth profile${migratedCount === 1 ? "" : "s"} in ${shortenHomePath(store.authPath)} to inline credentials (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      for (const refId of storeMigratedSidecarsByRefId.keys()) {
        unresolvedRefIds.add(refId);
      }
      result.warnings.push(
        `Failed to migrate legacy OAuth sidecars in ${shortenHomePath(store.authPath)}: ${String(err)}`,
      );
    }
  }

  for (const [refId, sidecarPath] of migratedSidecarsByRefId) {
    if (unresolvedRefIds.has(refId)) {
      continue;
    }
    try {
      fs.rmSync(sidecarPath, { force: true });
    } catch (err) {
      result.warnings.push(
        `Failed to remove migrated legacy OAuth sidecar ${shortenHomePath(sidecarPath)}: ${String(err)}`,
      );
    }
  }

  if (unreferencedSidecars.length > 0) {
    result.warnings.push(
      `Found ${unreferencedSidecars.length} unreferenced legacy Codex OAuth sidecar credential file${unreferencedSidecars.length === 1 ? "" : "s"}; left in place because external agent directories outside this scan may still reference ${unreferencedSidecars.length === 1 ? "it" : "them"}.`,
    );
  }

  if (result.changes.length > 0) {
    clearRuntimeAuthProfileStoreSnapshots();
  }
  if (emitNotes && result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (emitNotes && result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}

export const __testing = {
  buildLegacyOAuthSecretAad,
  buildLegacyOAuthSecretKey,
};
