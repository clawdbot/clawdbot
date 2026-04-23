import crypto from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  type ClaudeCliCredential,
  type CodexCliCredential,
} from "./cli-credentials.js";

type CliAuthEpochDeps = {
  readClaudeCliCredentialsCached: typeof readClaudeCliCredentialsCached;
  readCodexCliCredentialsCached: typeof readCodexCliCredentialsCached;
  loadAuthProfileStoreForRuntime: typeof loadAuthProfileStoreForRuntime;
};

const defaultCliAuthEpochDeps: CliAuthEpochDeps = {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  loadAuthProfileStoreForRuntime,
};

const cliAuthEpochDeps: CliAuthEpochDeps = { ...defaultCliAuthEpochDeps };

export const CLI_AUTH_EPOCH_VERSION = 3;

export function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void {
  Object.assign(cliAuthEpochDeps, overrides);
}

export function resetCliAuthEpochTestDeps(): void {
  Object.assign(cliAuthEpochDeps, defaultCliAuthEpochDeps);
}

function hashCliAuthEpochPart(value: string): string {
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
  if (credential.type === "oauth") {
    return encodeOAuthIdentity(credential);
  }
  return JSON.stringify(["token", credential.provider, credential.token]);
}

function encodeCodexCredential(credential: CodexCliCredential): string {
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

function getLocalCliCredentialFingerprint(provider: string): string | undefined {
  switch (provider) {
    case "claude-cli": {
      const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      return credential ? hashCliAuthEpochPart(encodeClaudeCredential(credential)) : undefined;
    }
    case "codex-cli": {
      const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
        ttlMs: 5000,
      });
      return credential ? hashCliAuthEpochPart(encodeCodexCredential(credential)) : undefined;
    }
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

export async function resolveCliAuthEpoch(params: {
  provider: string;
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
    const store = cliAuthEpochDeps.loadAuthProfileStoreForRuntime(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    const credential = getAuthProfileCredential(store, authProfileId);
    if (credential) {
      parts.push(
        `profile:${authProfileId}:${hashCliAuthEpochPart(encodeAuthProfileCredential(credential))}`,
      );
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return hashCliAuthEpochPart(parts.join("\n"));
}
