import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export const OAUTH_AGENT_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
];

export function resolveApiKeyForProfileInTest(
  resolver: typeof resolveApiKeyForProfile,
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolver({ cfg: {}, ...params });
}

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

export function storeWith(profileId: string, cred: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: cred } };
}

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

export async function createOAuthTestTempRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createOAuthMainAgentDir(stateDir: string): Promise<string> {
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return agentDir;
}

export async function removeOAuthTestTempRoot(tempRoot: string): Promise<void> {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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

export function resetOAuthProviderRuntimeMocks(mocks: {
  refreshProviderOAuthCredentialWithPluginMock: ResolvedValueMock;
  formatProviderAuthProfileApiKeyWithPluginMock: ReturnValueMock;
}): void {
  mocks.refreshProviderOAuthCredentialWithPluginMock.mockReset();
  mocks.refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
  mocks.formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
  mocks.formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
}

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

export function randomAsciiString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  const chars: string[] = [];
  for (let index = 0; index < len; index += 1) {
    chars.push(String.fromCodePoint(32 + Math.floor(rng() * 95)));
  }
  return chars.join("");
}

export function maybe<T>(rng: () => number, value: T): T | undefined {
  return rng() < 0.5 ? value : undefined;
}

export function randomlyCased(value: string, rng: () => number): string {
  return value
    .split("")
    .map((char) => (rng() < 0.5 ? char.toUpperCase() : char.toLowerCase()))
    .join("");
}
