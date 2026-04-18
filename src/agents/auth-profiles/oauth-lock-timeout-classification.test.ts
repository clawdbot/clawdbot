import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, type FileLockTimeoutError } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { clearRuntimeAuthProfileStoreSnapshots, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

function resolveApiKeyForProfileInTest(
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolveApiKeyForProfile({ cfg: {}, ...params });
}

const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(
    async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
  ),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: async () => undefined,
}));

vi.mock("../../infra/file-lock.js", () => ({
  FILE_LOCK_TIMEOUT_ERROR_CODE: "file_lock_timeout",
  resetFileLockStateForTest: () => undefined,
  withFileLock: withFileLockMock,
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  FILE_LOCK_TIMEOUT_ERROR_CODE: "file_lock_timeout",
  resetFileLockStateForTest: () => undefined,
  withFileLock: withFileLockMock,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

vi.mock("./external-cli-sync.js", async () => {
  const actual =
    await vi.importActual<typeof import("./external-cli-sync.js")>("./external-cli-sync.js");
  return {
    ...actual,
    syncExternalCliCredentials: () => false,
    readManagedExternalCliCredential: () => null,
    resolveExternalCliAuthProfiles: () => [],
    areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  };
});

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential,
    },
  };
}

function createLockTimeoutError(lockPath: string): FileLockTimeoutError {
  return Object.assign(new Error(`file lock timeout for ${lockPath.slice(0, -5)}`), {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE as typeof FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  });
}

describe("OAuth refresh lock timeout classification", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    withFileLockMock.mockReset();
    withFileLockMock.mockImplementation(
      async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
    );
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-lock-timeout-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });
    await loadOAuthModuleForTest();
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("maps only global refresh lock timeouts to refresh_contention", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const store = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(store, agentDir);

    const refreshLockPath = `${resolveOAuthRefreshLockPath(provider, profileId)}.lock`;
    withFileLockMock.mockImplementationOnce(async () => {
      throw createLockTimeoutError(refreshLockPath);
    });

    try {
      await resolveApiKeyForProfileInTest({
        store,
        profileId,
        agentDir,
      });
      throw new Error("expected refresh contention error");
    } catch (error) {
      expect((error as Error).message).toContain("another process is already refreshing");
      expect((error as Error).message).toContain(
        "Please wait for the in-flight refresh to finish and retry.",
      );
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: "refresh_contention",
      });
      expect(
        ((error as Error & { cause?: { cause?: unknown } }).cause as { cause?: unknown }).cause,
      ).toMatchObject({
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath: refreshLockPath,
      });
    }
  });

  it("preserves auth-store lock timeouts instead of remapping them to refresh_contention", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const store = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(store, agentDir);

    const authStoreLockPath = `${resolveAuthStorePath(agentDir)}.lock`;
    withFileLockMock
      .mockImplementationOnce(
        async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => await run(),
      )
      .mockImplementationOnce(async () => {
        throw createLockTimeoutError(authStoreLockPath);
      });

    try {
      await resolveApiKeyForProfileInTest({
        store,
        profileId,
        agentDir,
      });
      throw new Error("expected auth-store lock timeout");
    } catch (error) {
      expect((error as Error).message).toContain("file lock timeout");
      expect((error as Error).message).toContain("Please try again or re-authenticate.");
      expect((error as Error & { cause?: unknown }).cause).toMatchObject({
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath: authStoreLockPath,
      });
    }
  });
});
