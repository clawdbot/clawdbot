import * as childProcess from "node:child_process";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../../infra/json-file.js";

const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const LEGACY_OAUTH_SECRET_DIRNAME = "auth-profiles";
const LEGACY_OAUTH_SECRET_VERSION = 1;
const LEGACY_OAUTH_SECRET_ALGORITHM = "aes-256-gcm";
const LEGACY_OAUTH_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const LEGACY_OAUTH_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const LEGACY_OAUTH_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const LEGACY_OAUTH_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";

export type LegacyOAuthRef = {
  source: typeof LEGACY_OAUTH_REF_SOURCE;
  provider: typeof LEGACY_OAUTH_REF_PROVIDER;
  id: string;
};

export type LegacyOAuthSecretMaterial = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isLegacyOAuthRef(value: unknown): value is LegacyOAuthRef {
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

export function resolveLegacyOAuthSidecarPath(
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

function buildLegacyOAuthSecretAad(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
}): Buffer {
  return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}

function buildLegacyOAuthSecretKey(seed: string): Buffer {
  // Legacy #79006 compatibility: existing sidecars were encrypted with this
  // SHA-256 key derivation, so changing it would strand affected users.
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest();
}

function encryptLegacyOAuthMaterialForTest(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
  seed: string;
  material: Record<string, string>;
}): LegacyOAuthEncryptedPayload {
  const iv = Buffer.from("0102030405060708090a0b0c", "hex");
  const cipher = createCipheriv(
    LEGACY_OAUTH_SECRET_ALGORITHM,
    buildLegacyOAuthSecretKey(params.seed),
    iv,
  );
  cipher.setAAD(
    buildLegacyOAuthSecretAad({
      ref: params.ref,
      profileId: params.profileId,
      provider: params.provider,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(params.material), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: LEGACY_OAUTH_SECRET_ALGORITHM,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
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

function readLegacyMacOAuthSecretKeychainKey(params: {
  allowKeychainPrompt?: boolean;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (
    process.platform !== "darwin" ||
    params.allowKeychainPrompt === false ||
    params.env.VITEST === "true" ||
    params.env.VITEST_WORKER_ID !== undefined
  ) {
    return undefined;
  }
  try {
    // Read-only compatibility for #79006 sidecar OAuth profiles. Do not add
    // writes, creation, prompts, or new OS-level Keychain integrations here.
    // This exists only to keep affected users working until doctor migrates
    // them back to inline auth-profiles.json OAuth credentials.
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
  allowKeychainPrompt?: boolean;
}): LegacyOAuthSecretMaterial | null {
  const seeds = resolveLegacyOAuthSecretKeySeeds(params.env);
  for (const seed of seeds) {
    const material = decryptLegacyOAuthSecretMaterialWithSeed(params, seed);
    if (material) {
      return material;
    }
  }
  const keychainSeed = readLegacyMacOAuthSecretKeychainKey({
    allowKeychainPrompt: params.allowKeychainPrompt,
    env: params.env,
  });
  if (keychainSeed && !seeds.includes(keychainSeed)) {
    return decryptLegacyOAuthSecretMaterialWithSeed(params, keychainSeed);
  }
  return null;
}

export function loadLegacyOAuthSidecarMaterial(params: {
  ref: LegacyOAuthRef;
  profileId: string;
  provider: string;
  allowKeychainPrompt?: boolean;
  env?: NodeJS.ProcessEnv;
}): LegacyOAuthSecretMaterial | null {
  const env = params.env ?? process.env;
  const raw = loadJsonFile(resolveLegacyOAuthSidecarPath(params.ref, env));
  if (!isRecord(raw)) {
    return null;
  }
  if (
    raw.version !== LEGACY_OAUTH_SECRET_VERSION ||
    raw.profileId !== params.profileId ||
    raw.provider !== params.provider
  ) {
    return null;
  }
  const encrypted = coerceLegacyOAuthEncryptedPayload(raw.encrypted);
  if (encrypted) {
    return decryptLegacyOAuthSecretMaterial({
      ref: params.ref,
      profileId: params.profileId,
      provider: params.provider,
      encrypted,
      env,
      allowKeychainPrompt: params.allowKeychainPrompt,
    });
  }
  return normalizeLegacyOAuthSecretMaterial(raw);
}

export const legacyOAuthSidecarTestUtils = {
  buildLegacyOAuthSecretAad,
  buildLegacyOAuthSecretKey,
  encryptLegacyOAuthMaterial: encryptLegacyOAuthMaterialForTest,
};
