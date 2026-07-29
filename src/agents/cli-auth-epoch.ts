/**
 * Builds auth-state epochs for CLI-backed runtimes so reusable sessions reset
 * when the owning local credential identity changes.
 */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureAuthProfileStore, loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  type ClaudeCliCredential,
  type CodexCliCredential,
  type GeminiCliCredential,
} from "./cli-credentials.js";
import {
  resolveCliExecutableIdentity,
  type CliExecutableIdentity,
} from "./cli-executable-identity.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
} from "./execution-auth-binding.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

type CliAuthEpochDeps = {
  readClaudeCliCredentialsCached: typeof readClaudeCliCredentialsCached;
  readCodexCliCredentialsCached: typeof readCodexCliCredentialsCached;
  readGeminiCliCredentialsCached: typeof readGeminiCliCredentialsCached;
  ensureAuthProfileStore: typeof ensureAuthProfileStore;
  loadAuthProfileStoreForRuntime: typeof loadAuthProfileStoreForRuntime;
};

const defaultCliAuthEpochDeps: CliAuthEpochDeps = {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
};

const cliAuthEpochDeps: CliAuthEpochDeps = { ...defaultCliAuthEpochDeps };

/** Version salt for CLI auth epoch encoding semantics. */
export const CLI_AUTH_EPOCH_VERSION = 7;

const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";

/** Overrides credential readers for auth-epoch unit tests. */
function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void {
  Object.assign(cliAuthEpochDeps, overrides);
}

/** Restores default credential readers after auth-epoch unit tests. */
function resetCliAuthEpochTestDeps(): void {
  Object.assign(cliAuthEpochDeps, defaultCliAuthEpochDeps);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliAuthEpochTestApi")] = {
    setCliAuthEpochTestDeps,
    resetCliAuthEpochTestDeps,
  };
}

function hashCliAuthEpochPart(value: string): string {
  // Epoch hashes detect local auth-state changes; they are not password
  // storage or credential verification.
  // codeql[js/insufficient-password-hash]
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeUnknown(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function encodeOAuthIdentity(credential: {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
  enterpriseUrl?: string;
  projectId?: string;
  accountId?: string;
}): string {
  return JSON.stringify([
    "oauth",
    credential.provider,
    credential.clientId ?? null,
    credential.email ?? null,
    credential.enterpriseUrl ?? null,
    credential.projectId ?? null,
    credential.accountId ?? null,
  ]);
}

function encodeClaudeCredential(credential: ClaudeCliCredential): string {
  if (credential.type === "api_key_helper") {
    return JSON.stringify([credential.type, credential.provider, credential.helperHash]);
  }
  // Identity-only hashing for Claude CLI-managed credentials.
  // The Claude CLI keychain rewrite is not atomic: a token rotation can
  // briefly produce a partial read where `refreshToken` is missing, and the
  // parser falls back to a token-shaped credential. With the previous
  // token-inclusive hash, that transient race flipped the auth-epoch and
  // forced a session reset on every rotation. Routing these branches through
  // `encodeOAuthIdentity` collapses partial reads and rotations onto the same
  // provider-keyed identity hash. Helper auth stays distinct because changing
  // its configured command can switch accounts. Fixes #74312.
  return encodeOAuthIdentity({
    type: "oauth",
    provider: credential.provider,
  });
}

function encodeCodexCredential(credential: CodexCliCredential): string {
  return encodeOAuthIdentity(credential);
}

function encodeGeminiCredential(credential: GeminiCliCredential): string {
  // Delegate to the shared OAuth-identity encoder. The Gemini CLI reader
  // lifts the Google-account identity (sub, email) off the openid id_token
  // onto the credential, so the encoder fingerprints the user through stable,
  // non-secret identity fields — matching the Claude/Codex OAuth contract.
  // When the id_token is absent (older logins, scope omitted), the encoder
  // falls back to a provider-keyed constant, the same identity-less behavior
  // the Claude CLI OAuth branch tolerates.
  return encodeOAuthIdentity(credential);
}

function encodeAuthProfileCredential(credential: AuthProfileCredential): string {
  switch (credential.type) {
    case "api_key":
      return JSON.stringify([
        "api_key",
        credential.provider,
        credential.key ?? null,
        encodeUnknown(credential.keyRef),
        credential.email ?? null,
        credential.displayName ?? null,
        encodeUnknown(credential.metadata),
      ]);
    case "token":
      if (credential.tokenRef !== undefined) {
        // When a token profile has a stable account/ref identity, token
        // material is a refreshable secret rather than the session owner.
        // Plain token-only profiles still hash the token below so manual token
        // replacement keeps invalidating reusable sessions.
        return JSON.stringify([
          "token-identity",
          credential.provider,
          encodeUnknown(credential.tokenRef),
          credential.email ?? null,
          credential.displayName ?? null,
        ]);
      }
      return JSON.stringify([
        "token",
        credential.provider,
        credential.token ?? null,
        encodeUnknown(credential.tokenRef),
        credential.email ?? null,
        credential.displayName ?? null,
      ]);
    case "oauth":
      return encodeOAuthIdentity(credential);
  }
  throw new Error("Unsupported auth profile credential type");
}

function hasOAuthAccountIdentity(credential: AuthProfileCredential): boolean {
  return (
    credential.type === "oauth" &&
    (normalizeOptionalString(credential.accountId) !== undefined ||
      normalizeOptionalString(credential.email) !== undefined)
  );
}

function encodeAuthProfileEpochPart(
  authProfileId: string,
  credential: AuthProfileCredential,
): string {
  const credentialHash = hashCliAuthEpochPart(encodeAuthProfileCredential(credential));
  if (hasOAuthAccountIdentity(credential) && credential.provider !== GEMINI_CLI_PROVIDER_ID) {
    return `profile:oauth-identity:${credentialHash}`;
  }
  return `profile:${authProfileId}:${credentialHash}`;
}

function getLocalCliCredentialFingerprint(provider: string): string | undefined {
  switch (provider) {
    case "claude-cli": {
      const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      // Keep true credential absence absent so logout/removal invalidates
      // reusable sessions. The 5s credential cache still masks transient
      // null reads immediately after a successful read.
      return credential ? hashCliAuthEpochPart(encodeClaudeCredential(credential)) : undefined;
    }
    case "codex-cli": {
      const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      return credential ? hashCliAuthEpochPart(encodeCodexCredential(credential)) : undefined;
    }
    case "google-gemini-cli": {
      const credential = cliAuthEpochDeps.readGeminiCliCredentialsCached({
        ttlMs: 5000,
      });
      return credential ? hashCliAuthEpochPart(encodeGeminiCredential(credential)) : undefined;
    }
    default:
      return undefined;
  }
}

function getLocalCliCredential(provider: string): AuthProfileCredential | undefined {
  switch (provider) {
    case "claude-cli": {
      const auth = cliAuthEpochDeps.readClaudeCliCredentialsCached({
        ttlMs: 0,
        allowKeychainPrompt: false,
      });
      // Helper auth has no persisted secret/profile shape; its opaque command
      // fingerprint is already carried by getLocalCliCredentialFingerprint.
      return auth?.type === "api_key_helper" ? undefined : (auth ?? undefined);
    }
    case "codex-cli":
      return (
        cliAuthEpochDeps.readCodexCliCredentialsCached({
          ttlMs: 0,
          allowKeychainPrompt: false,
        }) ?? undefined
      );
    case "google-gemini-cli":
      return cliAuthEpochDeps.readGeminiCliCredentialsCached({ ttlMs: 0 }) ?? undefined;
    default:
      return undefined;
  }
}

function getAuthProfileCredential(
  store: AuthProfileStore,
  authProfileId: string | undefined,
): AuthProfileCredential | undefined {
  if (!authProfileId) {
    return undefined;
  }
  return store.profiles[authProfileId];
}

/** Resolves the stable auth epoch hash for a CLI runtime/provider session. */
export async function resolveCliAuthEpoch(params: {
  provider: string;
  agentDir?: string;
  authProfileId?: string;
  skipLocalCredential?: boolean;
}): Promise<string | undefined> {
  const provider = params.provider.trim();
  const authProfileId = normalizeOptionalString(params.authProfileId);
  const parts: string[] = [];

  if (params.skipLocalCredential !== true) {
    const localFingerprint = getLocalCliCredentialFingerprint(provider);
    if (localFingerprint) {
      parts.push(`local:${provider}:${localFingerprint}`);
    }
  }

  if (authProfileId) {
    const store = cliAuthEpochDeps.loadAuthProfileStoreForRuntime(params.agentDir, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    const credential = getAuthProfileCredential(store, authProfileId);
    if (credential) {
      parts.push(encodeAuthProfileEpochPart(authProfileId, credential));
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return hashCliAuthEpochPart(parts.join("\n"));
}

/**
 * Strict credential-owner proof for a verified inference turn. Unlike the
 * reusable-session epoch, identity-less OAuth tokens intentionally invalidate
 * on rotation because accepting an unknown replacement could cross accounts.
 */
export function resolveCliAuthBindingFingerprint(params: {
  provider: string;
  config: OpenClawConfig;
  agentDir?: string;
  authProfileId?: string;
  /** Exact selected profile material actually forwarded to this execution. */
  resolvedAuth?: ResolvedProviderAuth;
  skipLocalCredential?: boolean;
}): string | undefined {
  const provider = params.provider.trim();
  const authProfileId = normalizeOptionalString(params.authProfileId);
  const parts: string[] = [];
  const localCredential = params.skipLocalCredential ? undefined : getLocalCliCredential(provider);
  if (localCredential) {
    const fingerprint = fingerprintAuthProfileCredential({
      profileId: `local:${provider}`,
      credential: localCredential,
    });
    if (!fingerprint) {
      return undefined;
    }
    parts.push(`local:${fingerprint}`);
  }
  if (authProfileId) {
    const store = cliAuthEpochDeps.ensureAuthProfileStore(params.agentDir, {
      config: params.config,
      readOnly: true,
      allowKeychainPrompt: false,
      externalCliProviderIds: [provider],
    });
    const storedCredential = store.profiles[authProfileId];
    if (!storedCredential) {
      return undefined;
    }
    const fingerprint = fingerprintResolvedAuthProfileCredential({
      profileId: authProfileId,
      credential: storedCredential,
      resolvedAuth: params.resolvedAuth,
    });
    if (!fingerprint) {
      return undefined;
    }
    parts.push(`profile:${fingerprint}`);
  }
  return parts.length > 0
    ? hashCliAuthEpochPart(JSON.stringify(["strict-execution-v1", provider, parts]))
    : undefined;
}

type CliRuntimeArtifactFingerprintParams = {
  provider: string;
  config: OpenClawConfig;
  agentId?: string;
  runtimeArtifactId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executableIdentity?: CliExecutableIdentity;
};

/** Hash the exact executable plus backend-owned package implementation tree. */
export function fingerprintCliRuntimeArtifact(params: {
  provider: string;
  backendId: string;
  executableIdentity: CliExecutableIdentity;
}): string {
  return hashCliAuthEpochPart(
    JSON.stringify([
      "cli-runtime-artifact-v1",
      params.provider.trim(),
      params.backendId,
      params.executableIdentity,
    ]),
  );
}

/** Re-resolve a CLI backend's complete executable/package artifact boundary. */
export async function resolveCliRuntimeArtifactFingerprint(
  params: CliRuntimeArtifactFingerprintParams,
): Promise<string | undefined> {
  const provider = params.provider.trim();
  const backend = resolveCliBackendConfig(
    provider,
    params.config,
    params.agentId ? { agentId: params.agentId } : {},
  );
  if (!backend) {
    return undefined;
  }
  if (params.runtimeArtifactId && backend.id !== params.runtimeArtifactId) {
    return undefined;
  }
  if (params.executableIdentity && params.executableIdentity.command !== backend.config.command) {
    return undefined;
  }
  const executableIdentity =
    params.executableIdentity ??
    (await resolveCliExecutableIdentity({
      command: backend.config.command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(backend.runtimeArtifact ? { runtimeArtifact: backend.runtimeArtifact } : {}),
    }));
  if (!executableIdentity) {
    return undefined;
  }
  return fingerprintCliRuntimeArtifact({
    provider,
    backendId: backend.id,
    executableIdentity,
  });
}

/**
 * Resolve a CLI runtime's non-secret owner shape. The trusted runner emits
 * this projection only after a real successful turn; callers must not treat
 * this pre-run value as proof by itself.
 */
export async function resolveCliRuntimeOwnerFingerprint(params: {
  provider: string;
  config: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  runtimeOwnerId?: string;
  authProfileId?: string;
  skipLocalCredential?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executableIdentity?: CliExecutableIdentity;
  runtimeArtifactFingerprint?: string;
}): Promise<string | undefined> {
  const provider = params.provider.trim();
  const authProfileId = normalizeOptionalString(params.authProfileId);
  const backend = resolveCliBackendConfig(
    provider,
    params.config,
    params.agentId ? { agentId: params.agentId } : {},
  );
  if (!backend || (params.runtimeOwnerId && backend.id !== params.runtimeOwnerId)) {
    return undefined;
  }
  const runtimeArtifactFingerprint =
    params.runtimeArtifactFingerprint ??
    (await resolveCliRuntimeArtifactFingerprint({
      provider,
      config: params.config,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      runtimeArtifactId: backend.id,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.executableIdentity ? { executableIdentity: params.executableIdentity } : {}),
    }));
  if (!runtimeArtifactFingerprint) {
    return undefined;
  }
  let authProfileOwnerFingerprint: string | undefined;
  if (authProfileId) {
    const store = cliAuthEpochDeps.ensureAuthProfileStore(params.agentDir, {
      config: params.config,
      readOnly: true,
      allowKeychainPrompt: false,
      externalCliProviderIds: [provider],
    });
    authProfileOwnerFingerprint = fingerprintAuthProfileOwnerShape({
      profileId: authProfileId,
      credential: store.profiles[authProfileId],
    });
    if (!authProfileOwnerFingerprint) {
      return undefined;
    }
  }
  return fingerprintOpaqueRuntimeOwner({
    kind: "cli-runtime",
    runner: "cli",
    provider,
    backendId: backend.id,
    backendConfig: {
      config: backend.config,
      bundleMcp: backend.bundleMcp,
      bundleMcpMode: backend.bundleMcpMode,
      authEpochMode: backend.authEpochMode,
      nativeToolMode: backend.nativeToolMode,
      toolAvailabilityEnforcement: backend.toolAvailabilityEnforcement,
      sideQuestionToolMode: backend.sideQuestionToolMode,
    },
    ...(authProfileId ? { authProfileId } : {}),
    ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
    ...(params.skipLocalCredential ? { skipLocalCredential: true } : {}),
    runtimeArtifactFingerprint,
  });
}
