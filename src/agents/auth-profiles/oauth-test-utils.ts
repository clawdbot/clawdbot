/**
 * Shared OAuth test fixtures and temp-dir helpers.
 * Provides deterministic credential/store builders, state-dir setup, and
 * provider-runtime mock reset helpers for auth-profile tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { resolveApiKeyForProfile } from "./oauth.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

/** Environment keys OAuth tests override while creating isolated state roots. */
export const OAUTH_AGENT_ENV_KEYS = ["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR"];

/** Call resolveApiKeyForProfile with an empty config in tests. */
export function resolveApiKeyForProfileInTest(
  resolver: typeof resolveApiKeyForProfile,
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolver({ cfg: {}, ...params });
}

/** Build an OAuth credential fixture. */
export function oauthCred(params: {
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}): OAuthCredential {
  return { type: "oauth", ...params };
}

/** Build an auth profile store containing one credential. */
export function storeWith(profileId: string, cred: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: cred } };
}

/** Build an auth profile store containing one expired OAuth credential. */
export function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  email?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
        accountId: params.accountId,
        email: params.email,
      } satisfies OAuthCredential,
    },
  };
}

/** Create a temporary root directory for OAuth tests. */
export async function createOAuthTestTempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Create and export the main agent dir for OAuth tests. */
export async function createOAuthMainAgentDir(stateDir: string): Promise<string> {
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return agentDir;
}

/** Remove an OAuth temp root and close test databases first. */
export async function removeOAuthTestTempRoot(tempRoot: string): Promise<void> {
  if (tempRoot) {
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

/** Persist an auth profile store without external auth filtering/sync. */
export function writeAuthProfileStoreForTest(agentDir: string, store: AuthProfileStore): void {
  saveAuthProfileStore(store, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

/** Read a persisted auth profile store, falling back to an empty store. */
export function readAuthProfileStoreForTest(agentDir: string): AuthProfileStore {
  return loadPersistedAuthProfileStore(agentDir) ?? { version: 1, profiles: {} };
}

type ResettableMock = {
  mockReset(): unknown;
};

type ResolvedValueMock = ResettableMock & {
  mockResolvedValue(value: unknown): unknown;
};

type ReturnValueMock = ResettableMock & {
  mockReturnValue(value: unknown): unknown;
};

/** Reset provider-runtime OAuth mocks to default no-op behavior. */
export function resetOAuthProviderRuntimeMocks(mocks: {
  refreshProviderOAuthCredentialWithPluginMock: ResolvedValueMock;
  formatProviderAuthProfileApiKeyWithPluginMock: ReturnValueMock;
}): void {
  mocks.refreshProviderOAuthCredentialWithPluginMock.mockReset();
  mocks.refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
  mocks.formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
  mocks.formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
}

/** Create a deterministic pseudo-random generator for fuzz-style OAuth tests. */
export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random ASCII string using a deterministic RNG. */
export function randomAsciiString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  const chars: string[] = [];
  for (let index = 0; index < len; index += 1) {
    chars.push(String.fromCodePoint(32 + Math.floor(rng() * 95)));
  }
  return chars.join("");
}

/** Return a value about half the time using a deterministic RNG. */
export function maybe<T>(rng: () => number, value: T): T | undefined {
  return rng() < 0.5 ? value : undefined;
}

/** Randomize string casing using a deterministic RNG. */
export function randomlyCased(value: string, rng: () => number): string {
  return value
    .split("")
    .map((char) => (rng() < 0.5 ? char.toUpperCase() : char.toLowerCase()))
    .join("");
}
