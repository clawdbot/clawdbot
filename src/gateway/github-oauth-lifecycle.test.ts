import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolsGitHubStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import {
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  type GitHubOAuthRecord,
  type GitHubIdentityScope,
} from "../agents/github-oauth-records.js";
import type { GitHubToolAccount } from "../agents/github-tool-account.js";
import {
  GitHubAccountMismatchError,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { writeHiddenGitHubSecretRecord } from "../secrets/store/secret-store.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const mocks = vi.hoisted(() => ({
  verifyCredential: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollDeviceToken: vi.fn(),
  refreshToken: vi.fn(),
  createProfileId: vi.fn(),
  installProfile: vi.fn(),
  refreshProfile: vi.fn(),
  removeProfile: vi.fn(),
  writeOAuthRecord:
    vi.fn<(write: (record: GitHubOAuthRecord) => void, record: GitHubOAuthRecord) => void>(),
  resolveStatus: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../agents/github-oauth-client.js", () => ({
  verifyGitHubCredential: mocks.verifyCredential,
  requestGitHubOAuthDeviceCode: mocks.requestDeviceCode,
  pollGitHubOAuthDeviceToken: mocks.pollDeviceToken,
  refreshGitHubOAuthToken: mocks.refreshToken,
}));

vi.mock("../agents/github-oauth-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/github-oauth-records.js")>();
  return {
    ...actual,
    writeGitHubOAuthRecord: (record: GitHubOAuthRecord) =>
      mocks.writeOAuthRecord(actual.writeGitHubOAuthRecord, record),
  };
});

vi.mock("../agents/github-tool-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/github-tool-identity.js")>();
  return {
    ...actual,
    createManagedGitHubProfileId: mocks.createProfileId,
    installManagedGitHubProfile: mocks.installProfile,
    refreshManagedGitHubProfile: mocks.refreshProfile,
    removeManagedGitHubProfile: mocks.removeProfile,
    resolveGitHubToolIdentityStatus: mocks.resolveStatus,
  };
});

vi.mock("./github-tool-identity-config.js", () => ({
  updateGitHubToolIdentityConfig: mocks.updateConfig,
}));

import {
  createGitHubOAuthLifecycle,
  installActiveGitHubOAuthLifecycle,
  requestCurrentGitHubOAuthRefresh,
} from "./github-oauth-lifecycle.js";

type GitHubOAuthLifecycle = ReturnType<typeof createGitHubOAuthLifecycle>;

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const DEVICE_CODE = "d".repeat(40);
const OLD_PROFILE = `ghp_${"1".repeat(32)}`;
const NEW_PROFILE = `ghp_${"2".repeat(32)}`;
const OTHER_PROFILE = `ghp_${"3".repeat(32)}`;
const ACCOUNT: GitHubToolAccount = { accountId: 42, login: "roboclaw", avatarUrl: null };

const TOKENS = {
  accessToken: "access-token-secret",
  tokenType: "bearer" as const,
  scopes: ["gist", "read:org", "repo", "workflow"],
  expiresInSeconds: 28_800,
  refreshToken: "refresh-token-secret",
  refreshTokenExpiresInSeconds: 15_897_600,
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let currentConfig: OpenClawConfig;
let stateDir: string;
let installedTokens: string[];
let refreshedTokens: string[];
let lifecycleInstances: GitHubOAuthLifecycle[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function identity(profileId: string, options: { oauth?: boolean; author?: boolean } = {}) {
  return {
    profileId,
    ...(options.oauth ? { kind: "oauth" as const } : {}),
    ...(options.author
      ? { gitAuthor: { name: "Configured Author", email: "author@example.com" } }
      : {}),
  } satisfies GitHubToolIdentityConfig;
}

function configForScope(
  scope: GitHubIdentityScope,
  selected?: GitHubToolIdentityConfig,
): OpenClawConfig {
  return scope === "system"
    ? { tools: selected ? { github: selected } : {}, agents: { entries: { main: {} } } }
    : {
        tools: { github: identity(OTHER_PROFILE) },
        agents: { entries: { main: { tools: selected ? { github: selected } : {} } } },
      };
}

function selectedIdentity(
  scope: GitHubIdentityScope,
  agentId = "main",
): GitHubToolIdentityConfig | undefined {
  return resolveConfiguredGitHubToolIdentity({ config: currentConfig, scope, agentId });
}

function setSelectedIdentity(
  scope: GitHubIdentityScope,
  agentId: string,
  nextIdentity: GitHubToolIdentityConfig,
): void {
  const next = structuredClone(currentConfig);
  if (scope === "system") {
    next.tools ??= {};
    next.tools.github = structuredClone(nextIdentity);
  } else {
    next.agents ??= {};
    next.agents.entries ??= {};
    const entry = (next.agents.entries[agentId] ??= {});
    entry.tools ??= {};
    entry.tools.github = structuredClone(nextIdentity);
  }
  currentConfig = next;
}

function statusResult(scope: GitHubIdentityScope): ToolsGitHubStatusResult {
  return {
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: null },
    effective: {
      source: scope === "agent" ? "agent-override" : "system-configured",
      credentialKind: "managed-oauth",
      credentialState: "available",
      account: { login: ACCOUNT.login },
      gitAuthor: { name: ACCOUNT.login, email: null },
      evidence: "github-api",
      accessExpiresAtMs: NOW + TOKENS.expiresInSeconds * 1_000,
      refreshState: "available",
      oauthScopes: [...TOKENS.scopes],
      repositoryGrants: "unknown",
    },
  };
}

function createLifecycle(
  options: { getPersistedConfig?: () => OpenClawConfig } = {},
): GitHubOAuthLifecycle {
  const lifecycle = createGitHubOAuthLifecycle({
    getConfig: () => currentConfig,
    getPersistedConfig: options.getPersistedConfig ?? (() => currentConfig),
    warn: vi.fn(),
  });
  lifecycleInstances.push(lifecycle);
  return lifecycle;
}

async function startAuthorization(lifecycle: GitHubOAuthLifecycle, scope: GitHubIdentityScope) {
  return await lifecycle.startAuthorization({ scope, agentId: "main" });
}

async function advanceToPoll(requestId: string): Promise<void> {
  const record = readGitHubDeviceAuthorizationRecord(requestId);
  if (!record) {
    throw new Error("expected device authorization record");
  }
  vi.setSystemTime(record.nextPollAtMs);
}

function oauthRecord(
  profileId: string,
  overrides: Partial<GitHubOAuthRecord> = {},
): GitHubOAuthRecord {
  return {
    version: 1,
    profileId,
    scope: "system",
    agentId: "main",
    accountId: ACCOUNT.accountId,
    login: ACCOUNT.login,
    refreshToken: "refresh-token-current",
    accessExpiresAtMs: NOW + 5 * 60_000,
    refreshExpiresAtMs: NOW + 30 * 24 * 60 * 60_000,
    scopes: ["repo", "workflow"],
    createdAtMs: NOW - 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  closeOpenClawStateDatabaseForTest();
  stateDir = tempDirs.make("openclaw-github-oauth-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  currentConfig = configForScope("system");
  installedTokens = [];
  refreshedTokens = [];
  lifecycleInstances = [];

  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.requestDeviceCode.mockResolvedValue({
    deviceCode: DEVICE_CODE,
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
    intervalSeconds: 5,
  });
  mocks.createProfileId.mockReturnValue(NEW_PROFILE);
  mocks.removeProfile.mockResolvedValue(undefined);
  mocks.refreshProfile.mockImplementation(async ({ token }) => {
    refreshedTokens.push(token);
    return ACCOUNT;
  });
  mocks.writeOAuthRecord.mockImplementation((write, record) => write(record));
  mocks.resolveStatus.mockImplementation(async ({ selectedScope }) => statusResult(selectedScope));
  mocks.installProfile.mockImplementation(async ({ token, commitConfig }) => {
    installedTokens.push(token);
    await commitConfig(ACCOUNT);
    return ACCOUNT;
  });
  mocks.updateConfig.mockImplementation(async (params) => {
    const current = selectedIdentity(params.scope, params.agentId);
    if (!isDeepStrictEqual(current ?? null, params.expectedIdentity ?? null)) {
      throw new Error("GitHub identity changed while setup was in progress.");
    }
    if (!params.identity) {
      throw new Error("test mutation requires an identity");
    }
    setSelectedIdentity(params.scope, params.agentId, params.identity);
    return currentConfig;
  });
});

afterEach(async () => {
  await Promise.allSettled(lifecycleInstances.map(async (lifecycle) => await lifecycle.stop()));
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("GitHub OAuth authorization lifecycle", () => {
  it.each(["system", "agent"] as const)(
    "records an exact %s-scope CAS snapshot and delays the initial poll",
    async (scope) => {
      const expected = identity(OLD_PROFILE, { author: true });
      currentConfig = configForScope(scope, expected);
      const lifecycle = createLifecycle();

      const started = await startAuthorization(lifecycle, scope);
      const stored = readGitHubDeviceAuthorizationRecord(started.requestId);

      expect(stored).toEqual({
        version: 1,
        requestId: started.requestId,
        deviceCode: DEVICE_CODE,
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        createdAtMs: NOW,
        expiresAtMs: NOW + 900_000,
        pollIntervalMs: 5_000,
        nextPollAtMs: NOW + 5_000,
        agentId: "main",
        scope,
        expectedIdentity: expected,
        ...(scope === "agent"
          ? {
              agentLifecycleBinding: {
                agentId: "main",
                provenance: null,
              },
            }
          : {}),
      });
      expect(await lifecycle.pollAuthorization(started.requestId)).toEqual({
        status: "pending",
        retryAfterMs: 5_000,
      });
      expect(mocks.pollDeviceToken).not.toHaveBeenCalled();
    },
  );

  it("preserves custom Git author data when reconnecting an existing identity", async () => {
    const previous = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", previous);
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
    await advanceToPoll(started.requestId);

    await lifecycle.pollAuthorization(started.requestId);

    expect(selectedIdentity("system")).toEqual({
      profileId: NEW_PROFILE,
      kind: "oauth",
      gitAuthor: previous.gitAuthor,
    });
  });

  it("applies pending and cumulative server slow_down intervals to the durable record", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken
      .mockResolvedValueOnce({ status: "authorization_pending" })
      .mockResolvedValueOnce({ status: "slow_down" })
      .mockResolvedValueOnce({ status: "slow_down", intervalSeconds: 20 })
      .mockResolvedValueOnce({ status: "slow_down", intervalSeconds: 12 });

    await advanceToPoll(started.requestId);
    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 5_000,
    });
    await advanceToPoll(started.requestId);
    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "slow_down",
      retryAfterMs: 10_000,
    });
    await advanceToPoll(started.requestId);
    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "slow_down",
      retryAfterMs: 20_000,
    });
    await advanceToPoll(started.requestId);
    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "slow_down",
      retryAfterMs: 25_000,
    });
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toMatchObject({
      pollIntervalMs: 25_000,
      nextPollAtMs: NOW + 65_000,
    });
  });

  it.each([
    [{ status: "access_denied" }, { status: "access_denied" }],
    [{ status: "expired_token" }, { status: "expired" }],
    [{ status: "error", code: "incorrect_device_code" }, { status: "incorrect_device_code" }],
    [
      { status: "error", code: "device_flow_disabled" },
      { status: "failed", reason: "setup_failed" },
    ],
  ] as const)(
    "returns typed terminal state %# and deletes pending state",
    async (upstream, expected) => {
      const lifecycle = createLifecycle();
      const started = await startAuthorization(lifecycle, "system");
      mocks.pollDeviceToken.mockResolvedValue(upstream);
      await advanceToPoll(started.requestId);

      await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual(expected);
      expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
    },
  );

  it("keeps a network failure retryable without exposing upstream diagnostics", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken.mockRejectedValue(new Error("access-token-secret upstream failure"));
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "network_error",
      retryAfterMs: 5_000,
    });
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toMatchObject({
      nextPollAtMs: NOW + 10_000,
    });
  });

  it("expires locally without polling GitHub", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    const stored = readGitHubDeviceAuthorizationRecord(started.requestId);
    if (!stored) {
      throw new Error("expected device authorization record");
    }
    vi.setSystemTime(stored.expiresAtMs);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "expired",
    });
    expect(mocks.pollDeviceToken).not.toHaveBeenCalled();
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
  });

  it.each(["system", "agent"] as const)(
    "installs a secret-free %s OAuth generation and removes pending state",
    async (scope) => {
      currentConfig = configForScope(scope);
      const lifecycle = createLifecycle();
      const started = await startAuthorization(lifecycle, scope);
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      await advanceToPoll(started.requestId);

      const result = await lifecycle.pollAuthorization(started.requestId);

      expect(result).toEqual({ status: "success", githubStatus: statusResult(scope) });
      expect(JSON.stringify(result)).not.toContain(TOKENS.accessToken);
      expect(JSON.stringify(result)).not.toContain(TOKENS.refreshToken);
      expect(installedTokens).toEqual([TOKENS.accessToken]);
      expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
      expect(selectedIdentity(scope)).toEqual({
        profileId: NEW_PROFILE,
        kind: "oauth",
        gitAuthor: {
          name: ACCOUNT.login,
          email: `${ACCOUNT.accountId}+${ACCOUNT.login}@users.noreply.github.com`,
        },
      });
      expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toEqual({
        state: "valid",
        record: expect.objectContaining({
          profileId: NEW_PROFILE,
          scope,
          agentId: "main",
          accountId: ACCOUNT.accountId,
          login: ACCOUNT.login,
          refreshToken: TOKENS.refreshToken,
          scopes: TOKENS.scopes,
        }),
      });
    },
  );

  it("singleflights concurrent polls for one request", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    const upstream = deferred<{ status: "authorization_pending" }>();
    mocks.pollDeviceToken.mockReturnValue(upstream.promise);
    await advanceToPoll(started.requestId);

    const first = lifecycle.pollAuthorization(started.requestId);
    const second = lifecycle.pollAuthorization(started.requestId);
    expect(second).toBe(first);
    expect(mocks.pollDeviceToken).toHaveBeenCalledOnce();
    upstream.resolve({ status: "authorization_pending" });
    await expect(first).resolves.toMatchObject({ status: "pending" });
  });

  it("fences an in-flight token exchange after the operator cancels", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    const upstream = deferred<{ status: "authorized"; tokens: typeof TOKENS }>();
    mocks.pollDeviceToken.mockReturnValue(upstream.promise);
    await advanceToPoll(started.requestId);

    const result = lifecycle.pollAuthorization(started.requestId);
    expect(lifecycle.cancelAuthorization(started.requestId)).toBe(true);
    upstream.resolve({ status: "authorized", tokens: TOKENS });

    await expect(result).resolves.toEqual({ status: "expired" });
    expect(mocks.installProfile).not.toHaveBeenCalled();
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
  });

  it.each(["cancellation", "expiry"] as const)(
    "fences profile installation when %s wins before commit",
    async (race) => {
      const lifecycle = createLifecycle();
      const started = await startAuthorization(lifecycle, "system");
      const installStarted = deferred<void>();
      const continueInstall = deferred<void>();
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      mocks.installProfile.mockImplementationOnce(async ({ token, commitConfig }) => {
        installedTokens.push(token);
        installStarted.resolve();
        await continueInstall.promise;
        await commitConfig(ACCOUNT);
        return ACCOUNT;
      });
      await advanceToPoll(started.requestId);

      const result = lifecycle.pollAuthorization(started.requestId);
      await installStarted.promise;
      if (race === "cancellation") {
        expect(lifecycle.cancelAuthorization(started.requestId)).toBe(true);
      } else {
        vi.setSystemTime(readGitHubDeviceAuthorizationRecord(started.requestId)!.expiresAtMs);
      }
      continueInstall.resolve();

      await expect(result).resolves.toEqual({ status: "failed", reason: "setup_failed" });
      expect(selectedIdentity("system")).toBeUndefined();
      expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toEqual({ state: "missing" });
      expect(mocks.removeProfile).toHaveBeenCalledOnce();
    },
  );

  it("reports cancellation as too late once the config commit starts", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    const commitStarted = deferred<void>();
    const continueCommit = deferred<void>();
    mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
    mocks.updateConfig.mockImplementationOnce(async (params) => {
      commitStarted.resolve();
      await continueCommit.promise;
      setSelectedIdentity(params.scope, params.agentId, params.identity);
      return currentConfig;
    });
    await advanceToPoll(started.requestId);

    const result = lifecycle.pollAuthorization(started.requestId);
    await commitStarted.promise;
    expect(lifecycle.cancelAuthorization(started.requestId)).toBe(false);
    continueCommit.resolve();

    await expect(result).resolves.toEqual({
      status: "success",
      githubStatus: statusResult("system"),
    });
    expect(selectedIdentity("system")).toMatchObject({ profileId: NEW_PROFILE, kind: "oauth" });
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
  });

  it("rejects an authorization whose selected identity changes while polling", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    const upstream = deferred<{ status: "authorized"; tokens: typeof TOKENS }>();
    mocks.pollDeviceToken.mockReturnValue(upstream.promise);
    await advanceToPoll(started.requestId);

    const result = lifecycle.pollAuthorization(started.requestId);
    setSelectedIdentity("system", "main", identity(OTHER_PROFILE));
    upstream.resolve({ status: "authorized", tokens: TOKENS });

    await expect(result).resolves.toEqual({ status: "failed", reason: "identity_changed" });
    expect(mocks.installProfile).not.toHaveBeenCalled();
    expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
  });

  it.each(["install", "config"] as const)(
    "rolls back pending and metadata state after initial %s failure",
    async (failure) => {
      const lifecycle = createLifecycle();
      const started = await startAuthorization(lifecycle, "system");
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      if (failure === "install") {
        mocks.installProfile.mockRejectedValue(new Error("profile install failed"));
      } else {
        mocks.updateConfig.mockRejectedValue(new Error("config CAS failed"));
      }
      await advanceToPoll(started.requestId);

      await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
        status: "failed",
        reason: "setup_failed",
      });
      expect(readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
      expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toEqual({ state: "missing" });
      expect(selectedIdentity("system")).toBeUndefined();
    },
  );

  it("preserves an initial OAuth generation when config committed before throwing", async () => {
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
    mocks.updateConfig.mockImplementationOnce(async (params) => {
      setSelectedIdentity(params.scope, params.agentId, params.identity);
      throw new Error("config write outcome unknown");
    });
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "success",
      githubStatus: statusResult("system"),
    });
    expect(selectedIdentity("system")).toMatchObject({ profileId: NEW_PROFILE, kind: "oauth" });
    expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({ state: "valid" });
    expect(mocks.removeProfile).not.toHaveBeenCalled();
  });

  it("retains an ambiguous initial commit until authoritative config becomes readable", async () => {
    const runtimeBefore = configForScope("system");
    currentConfig = runtimeBefore;
    let persisted = runtimeBefore;
    let persistedReadable = false;
    const lifecycle = createLifecycle({
      getPersistedConfig: () => {
        if (!persistedReadable) {
          throw new Error("persisted config temporarily unreadable");
        }
        return persisted;
      },
    });
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
    mocks.updateConfig.mockImplementationOnce(async (params) => {
      const next = structuredClone(runtimeBefore);
      next.tools ??= {};
      next.tools.github = params.identity;
      persisted = next;
      throw new Error("persisted write completed but response was lost");
    });
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "failed",
      reason: "setup_failed",
    });
    expect(currentConfig).toEqual(runtimeBefore);
    expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({
      state: "valid",
      record: { pendingInitial: { requestId: started.requestId } },
    });

    await lifecycle.maintain();
    expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({
      state: "valid",
      record: { pendingInitial: { requestId: started.requestId } },
    });

    persistedReadable = true;
    await lifecycle.maintain();
    expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toEqual({
      state: "valid",
      record: expect.not.objectContaining({ pendingInitial: expect.anything() }),
    });
    currentConfig = persisted;
    expect(selectedIdentity("system")).toMatchObject({ profileId: NEW_PROFILE, kind: "oauth" });
    expect(mocks.removeProfile).not.toHaveBeenCalled();
  });

  it("rolls back an ambiguous initial candidate when authoritative config proves no commit", async () => {
    const persisted = configForScope("system");
    currentConfig = persisted;
    const lifecycle = createLifecycle({ getPersistedConfig: () => persisted });
    const started = await startAuthorization(lifecycle, "system");
    mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
    mocks.updateConfig.mockRejectedValueOnce(new Error("config CAS failed"));
    await advanceToPoll(started.requestId);

    await lifecycle.pollAuthorization(started.requestId);
    await lifecycle.maintain();

    expect(inspectGitHubOAuthRecord(NEW_PROFILE)).toEqual({ state: "missing" });
    expect(mocks.removeProfile).toHaveBeenCalledWith(expect.stringContaining(NEW_PROFILE));
  });

  it("rejects an agent authorization after the agent enters deletion", async () => {
    currentConfig = configForScope("agent");
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "agent");
    const deletion = beginAgentDeletion({
      agentId: "main",
      agentDir: "/agents/main",
      workspaceDir: "/workspaces/main",
      sessionsDir: "/sessions/main",
    });
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "failed",
      reason: "identity_changed",
    });
    expect(mocks.pollDeviceToken).not.toHaveBeenCalled();
    expect(mocks.installProfile).not.toHaveBeenCalled();
    deletion.rollback();
  });

  it("rejects an agent authorization after same-id recreation gets fresh provenance", async () => {
    currentConfig = configForScope("agent");
    const lifecycle = createLifecycle();
    const started = await startAuthorization(lifecycle, "agent");
    recordAgentProvenance("main", { createdVia: "operator" }, { nowMs: NOW + 1 });
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "failed",
      reason: "identity_changed",
    });
    expect(mocks.installProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(
      resolveConfiguredGitHubToolIdentity({
        config: currentConfig,
        scope: "agent",
        agentId: "main",
      }),
    ).toBeUndefined();
  });

  it("replaces an older pending authorization for the same exact scope only", async () => {
    const lifecycle = createLifecycle();
    const systemFirst = await startAuthorization(lifecycle, "system");
    const agent = await startAuthorization(lifecycle, "agent");
    const systemSecond = await startAuthorization(lifecycle, "system");

    expect(readGitHubDeviceAuthorizationRecord(systemFirst.requestId)).toBeUndefined();
    expect(readGitHubDeviceAuthorizationRecord(agent.requestId)).toBeDefined();
    expect(readGitHubDeviceAuthorizationRecord(systemSecond.requestId)).toBeDefined();
  });
});

describe("GitHub OAuth refresh and maintenance", () => {
  it("respects refresh skew and marks transient and terminal refresh failures", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    const lifecycle = createLifecycle();

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE, { accessExpiresAtMs: NOW + 10 * 60_000 + 1 }));
    await lifecycle.refreshEffectiveIdentity("main");
    expect(mocks.refreshToken).not.toHaveBeenCalled();

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockRejectedValueOnce(new Error("network unavailable"));
    await lifecycle.refreshEffectiveIdentity("main");
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshFailure: "failed" },
    });

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValueOnce({ status: "error", code: "bad_refresh_token" });
    await lifecycle.refreshEffectiveIdentity("main");
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshFailure: "expired" },
    });
  });

  it("refreshes credentials in the selected profile without changing config", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");

    expect(refreshedTokens).toEqual([TOKENS.accessToken]);
    expect(mocks.refreshProfile).toHaveBeenCalledWith({
      profileDir: expect.stringContaining(OLD_PROFILE),
      token: TOKENS.accessToken,
      expectedAccountId: ACCOUNT.accountId,
    });
    expect(selectedIdentity("system")).toEqual(configured);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.createProfileId).not.toHaveBeenCalled();
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toEqual({
      state: "valid",
      record: expect.objectContaining({
        profileId: OLD_PROFILE,
        refreshToken: TOKENS.refreshToken,
        scopes: TOKENS.scopes,
      }),
    });
  });

  it("accepts a renamed login for the same durable account and preserves Git author", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    mocks.refreshProfile.mockResolvedValue({
      accountId: ACCOUNT.accountId,
      login: "renamed-roboclaw",
      avatarUrl: null,
    });
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");

    expect(selectedIdentity("system")).toEqual(configured);
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { accountId: ACCOUNT.accountId, login: "renamed-roboclaw" },
    });
  });

  it("finishes an accepted refresh for already-admitted runs after config changes", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    const upstream = deferred<{ status: "refreshed"; tokens: typeof TOKENS }>();
    mocks.refreshToken.mockReturnValue(upstream.promise);
    const lifecycle = createLifecycle();

    const refresh = lifecycle.refreshEffectiveIdentity("main");
    await vi.waitFor(() => expect(mocks.refreshToken).toHaveBeenCalledOnce());
    setSelectedIdentity("system", "main", identity(OTHER_PROFILE, { oauth: true }));
    upstream.resolve({ status: "refreshed", tokens: TOKENS });
    await refresh;

    expect(selectedIdentity("system")).toMatchObject({ profileId: OTHER_PROFILE });
    expect(mocks.refreshProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: expect.stringContaining(OLD_PROFILE) }),
    );
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshToken: TOKENS.refreshToken },
    });
  });

  it("rejects a refreshed credential for a different durable account", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    mocks.refreshProfile.mockRejectedValue(
      new GitHubAccountMismatchError("GitHub OAuth refresh returned a different account."),
    );
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");

    expect(selectedIdentity("system")).toEqual(configured);
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: {
        accountId: ACCOUNT.accountId,
        login: ACCOUNT.login,
        refreshFailure: "expired",
      },
    });
  });

  it("retries the first durable write from lifecycle-owned memory", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    mocks.writeOAuthRecord.mockImplementationOnce(() => {
      throw new Error("SQLite temporarily unavailable");
    });
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");
    expect(mocks.refreshProfile).not.toHaveBeenCalled();
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshToken: "refresh-token-current" },
    });

    await lifecycle.maintain();

    expect(mocks.refreshToken).toHaveBeenCalledOnce();
    expect(mocks.refreshProfile).toHaveBeenCalledOnce();
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshToken: TOKENS.refreshToken },
    });
  });

  it("singleflights refresh and ignores calls after the active lifecycle disconnects", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    const upstream = deferred<{ status: "error"; code: "bad_refresh_token" }>();
    mocks.refreshToken.mockReturnValue(upstream.promise);
    const lifecycle = createLifecycle();
    const uninstall = installActiveGitHubOAuthLifecycle(lifecycle);

    const first = requestCurrentGitHubOAuthRefresh("main");
    const second = requestCurrentGitHubOAuthRefresh("main");
    expect(mocks.refreshToken).toHaveBeenCalledOnce();
    upstream.resolve({ status: "error", code: "bad_refresh_token" });
    await Promise.all([first, second]);

    uninstall();
    await requestCurrentGitHubOAuthRefresh("main");
    expect(mocks.refreshToken).toHaveBeenCalledOnce();
  });

  it("recovers a durable pending refresh after profile replacement fails", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    mocks.refreshProfile.mockRejectedValueOnce(new Error("disk temporarily unavailable"));
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { pendingRefresh: true, refreshToken: TOKENS.refreshToken },
    });

    await lifecycle.maintain();

    expect(mocks.refreshToken).toHaveBeenCalledTimes(2);
    expect(mocks.refreshProfile).toHaveBeenCalledTimes(2);
    expect(selectedIdentity("system")).toEqual(configured);
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toEqual({
      state: "valid",
      record: expect.not.objectContaining({ pendingRefresh: expect.anything() }),
    });
  });

  it("recovers a durable pending refresh after final metadata write fails", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "refreshed", tokens: TOKENS });
    let writes = 0;
    mocks.writeOAuthRecord.mockImplementation((write, record) => {
      writes += 1;
      if (writes === 2) {
        throw new Error("final metadata write failed");
      }
      write(record);
    });
    const lifecycle = createLifecycle();

    await lifecycle.refreshEffectiveIdentity("main");
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { pendingRefresh: true, refreshToken: TOKENS.refreshToken },
    });

    await lifecycle.maintain();

    expect(mocks.refreshToken).toHaveBeenCalledTimes(2);
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toEqual({
      state: "valid",
      record: expect.not.objectContaining({ pendingRefresh: expect.anything() }),
    });
  });

  it("drains a non-idempotent refresh before shutdown completes", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true, author: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    const upstream = deferred<{ status: "refreshed"; tokens: typeof TOKENS }>();
    mocks.refreshToken.mockReturnValue(upstream.promise);
    const lifecycle = createLifecycle();

    const refresh = lifecycle.refreshEffectiveIdentity("main");
    await vi.waitFor(() => expect(mocks.refreshToken).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    upstream.resolve({ status: "refreshed", tokens: TOKENS });
    await Promise.all([refresh, stop]);

    expect(stopped).toBe(true);
    expect(mocks.refreshProfile).toHaveBeenCalledOnce();
    expect(inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({
      state: "valid",
      record: { refreshToken: TOKENS.refreshToken },
    });
  });

  it("cleans expired device state, orphan OAuth metadata, and corrupt hidden records", async () => {
    currentConfig = configForScope("system");
    const expiredRequestId = `github-device-${"a".repeat(32)}`;
    writeGitHubDeviceAuthorizationRecord({
      version: 1,
      requestId: expiredRequestId,
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      createdAtMs: NOW - 10_000,
      expiresAtMs: NOW - 1,
      pollIntervalMs: 5_000,
      nextPollAtMs: NOW - 5_000,
      agentId: "main",
      scope: "system",
      expectedIdentity: null,
    });
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    writeHiddenGitHubSecretRecord({
      name: `github-oauth-${"4".repeat(32)}`,
      value: "corrupt",
    });
    const lifecycle = createLifecycle();

    await lifecycle.maintain();

    expect(listGitHubDeviceAuthorizationRecords()).toEqual([]);
    expect(listGitHubOAuthRecords()).toEqual([]);
  });

  it("runs maintenance immediately and periodically, then stops scheduling", async () => {
    const configured = identity(OLD_PROFILE, { oauth: true });
    currentConfig = configForScope("system", configured);
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    mocks.refreshToken.mockResolvedValue({ status: "error", code: "device_flow_disabled" });
    const lifecycle = createLifecycle();

    lifecycle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.refreshToken).toHaveBeenCalledOnce();

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshToken).toHaveBeenCalledTimes(2);

    await lifecycle.stop();
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshToken).toHaveBeenCalledTimes(2);
  });
});
