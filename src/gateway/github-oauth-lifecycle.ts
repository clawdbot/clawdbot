import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import {
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
  requestGitHubOAuthDeviceCode,
  type GitHubOAuthTokenPair,
} from "../agents/github-oauth-client.js";
import {
  createGitHubOAuthRecord,
  deleteGitHubDeviceAuthorizationRecord,
  deleteGitHubOAuthRecord,
  inspectGitHubOAuthRecord,
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  type GitHubDeviceAuthorizationRecord,
  type GitHubIdentityScope,
  type GitHubOAuthRecord,
  writeGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
} from "../agents/github-oauth-records.js";
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  isPrivateManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
  type GitHubToolAccount,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { formatErrorMessage } from "../infra/errors.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

const DEVICE_MAX_LIFETIME_SECONDS = 15 * 60;
const DEVICE_MAX_POLL_INTERVAL_SECONDS = 60;
const REFRESH_SKEW_MS = 10 * 60_000;
const MAINTENANCE_INTERVAL_MS = 60_000;

type ConfiguredOAuthIdentity = {
  scope: GitHubIdentityScope;
  agentId: string;
  identity: GitHubToolIdentityConfig & { kind: "oauth" };
};

type GitHubOAuthLifecycle = ReturnType<typeof createGitHubOAuthLifecycle>;

let activeLifecycle: GitHubOAuthLifecycle | undefined;

export function installActiveGitHubOAuthLifecycle(lifecycle: GitHubOAuthLifecycle): () => void {
  activeLifecycle = lifecycle;
  return () => {
    if (activeLifecycle === lifecycle) {
      activeLifecycle = undefined;
    }
  };
}

export async function requestCurrentGitHubOAuthRefresh(agentId: string): Promise<void> {
  await activeLifecycle?.refreshEffectiveIdentity(agentId);
}

const defaultGitAuthor = (account: GitHubToolAccount) => ({
  name: account.login,
  email: `${account.accountId}+${account.login}@users.noreply.github.com`,
});

function identityStillSelected(
  config: OpenClawConfig,
  location: {
    scope: GitHubIdentityScope;
    agentId: string;
  },
  expected: GitHubToolIdentityConfig | null,
): boolean {
  const current = resolveConfiguredGitHubToolIdentity({ config, ...location });
  return isDeepStrictEqual(current ?? null, expected);
}

function configuredOAuthIdentities(config: OpenClawConfig): ConfiguredOAuthIdentity[] {
  const identities: ConfiguredOAuthIdentity[] = [];
  const system = config.tools?.github;
  if (system?.kind === "oauth") {
    identities.push({
      scope: "system",
      agentId: "system",
      identity: { ...system, kind: "oauth" },
    });
  }
  for (const agentId of listAgentIds(config).toSorted()) {
    const identity = resolveAgentConfig(config, agentId)?.tools?.github;
    if (identity?.kind === "oauth") {
      identities.push({ scope: "agent", agentId, identity: { ...identity, kind: "oauth" } });
    }
  }
  return identities;
}

function currentIdentityForRecord(
  config: OpenClawConfig,
  record: Pick<GitHubOAuthRecord, "scope" | "agentId">,
): GitHubToolIdentityConfig | undefined {
  return resolveConfiguredGitHubToolIdentity({ config, ...record });
}

export function createGitHubOAuthLifecycle(params: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig?: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  const controller = new AbortController();
  const devicePolls = new Map<string, Promise<ToolsGitHubAuthorizePollResult>>();
  const committingRequests = new Set<string>();
  const refreshes = new Map<string, Promise<void>>();
  const pendingRotations = new Map<string, GitHubOAuthRecord>();
  const pendingCleanup = new Set<string>();
  let maintenance: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const queueDeviceCleanup = (requestId: string) => {
    try {
      deleteGitHubDeviceAuthorizationRecord(requestId);
      pendingCleanup.delete(requestId);
    } catch {
      pendingCleanup.add(requestId);
    }
  };

  const queueOAuthCleanup = (profileId: string) => {
    try {
      deleteGitHubOAuthRecord(profileId);
    } catch {
      // Orphan cleanup scans every minute and after restart.
    }
  };

  const status = (agentId: string, selectedScope: GitHubIdentityScope) =>
    resolveGitHubToolIdentityStatus({ config: params.getConfig(), agentId, selectedScope });

  const installDeviceTokens = async (
    record: GitHubDeviceAuthorizationRecord,
    tokens: GitHubOAuthTokenPair,
  ): Promise<ToolsGitHubAuthorizePollResult> => {
    const current = params.getConfig();
    if (!identityStillSelected(current, record, record.expectedIdentity)) {
      queueDeviceCleanup(record.requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    const profileId = createManagedGitHubProfileId();
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: record.agentId,
      scope: record.scope,
      profileId,
    });
    let nextConfig = current;
    let metadataWritten = false;
    try {
      await installManagedGitHubProfile({
        profileDir,
        token: tokens.accessToken,
        retainProfileOnCommitFailure: true,
        commitConfig: async (account) => {
          const pending = readGitHubDeviceAuthorizationRecord(record.requestId);
          if (
            !pending ||
            pending.createdAtMs !== record.createdAtMs ||
            pending.deviceCode !== record.deviceCode ||
            !isDeepStrictEqual(pending.expectedIdentity, record.expectedIdentity) ||
            !identityStillSelected(params.getConfig(), record, record.expectedIdentity)
          ) {
            throw new Error("GitHub authorization is no longer pending.");
          }
          committingRequests.add(record.requestId);
          writeGitHubOAuthRecord(
            createGitHubOAuthRecord({
              profileId,
              scope: record.scope,
              agentId: record.agentId,
              account,
              tokens,
              now: Date.now(),
            }),
          );
          metadataWritten = true;
          const identity: GitHubToolIdentityConfig = {
            profileId,
            kind: "oauth",
            gitAuthor: defaultGitAuthor(account),
          };
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: record.scope,
            agentId: record.agentId,
            identity,
            expectedIdentity: record.expectedIdentity,
          });
        },
      });
    } catch {
      if (metadataWritten) {
        try {
          const persistedConfig = params.getPersistedConfig?.() ?? params.getConfig();
          const persistedIdentity = resolveConfiguredGitHubToolIdentity({
            config: persistedConfig,
            scope: record.scope,
            agentId: record.agentId,
          });
          if (persistedIdentity?.profileId === profileId && persistedIdentity.kind === "oauth") {
            queueDeviceCleanup(record.requestId);
            if (record.expectedIdentity?.kind === "oauth") {
              queueOAuthCleanup(record.expectedIdentity.profileId);
            }
            return {
              status: "success",
              githubStatus: await resolveGitHubToolIdentityStatus({
                config: persistedConfig,
                agentId: record.agentId,
                selectedScope: record.scope,
              }),
            };
          }
        } catch {
          // The commit outcome is unknown. Preserve the profile and refresh
          // record so lifecycle reconciliation can decide from durable config.
          queueDeviceCleanup(record.requestId);
          return { status: "failed", reason: "setup_failed" };
        }
      }
      if (metadataWritten) {
        queueOAuthCleanup(profileId);
      }
      await removeManagedGitHubProfile(profileDir).catch(() => undefined);
      queueDeviceCleanup(record.requestId);
      return { status: "failed", reason: "setup_failed" };
    } finally {
      committingRequests.delete(record.requestId);
    }
    queueDeviceCleanup(record.requestId);
    if (record.expectedIdentity?.kind === "oauth") {
      queueOAuthCleanup(record.expectedIdentity.profileId);
    }
    return {
      status: "success",
      githubStatus: await resolveGitHubToolIdentityStatus({
        config: nextConfig,
        agentId: record.agentId,
        selectedScope: record.scope,
      }),
    };
  };

  const pollOnce = async (requestId: string): Promise<ToolsGitHubAuthorizePollResult> => {
    const record = readGitHubDeviceAuthorizationRecord(requestId);
    const now = Date.now();
    if (!record || record.expiresAtMs <= now) {
      queueDeviceCleanup(requestId);
      return { status: "expired" };
    }
    if (!identityStillSelected(params.getConfig(), record, record.expectedIdentity)) {
      queueDeviceCleanup(requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    if (now < record.nextPollAtMs) {
      return { status: "pending", nextPollAtMs: record.nextPollAtMs };
    }
    let result;
    try {
      result = await pollGitHubOAuthDeviceToken({
        deviceCode: record.deviceCode,
        signal: controller.signal,
      });
    } catch {
      const currentRecord = readGitHubDeviceAuthorizationRecord(requestId);
      if (!currentRecord) {
        return { status: "expired" };
      }
      const retryAtMs = Math.min(currentRecord.expiresAtMs, now + currentRecord.pollIntervalMs);
      writeGitHubDeviceAuthorizationRecord({ ...currentRecord, nextPollAtMs: retryAtMs });
      return { status: "network_error", retryAtMs };
    }
    const currentRecord = readGitHubDeviceAuthorizationRecord(requestId);
    if (!currentRecord) {
      return { status: "expired" };
    }
    if (
      currentRecord.deviceCode !== record.deviceCode ||
      currentRecord.createdAtMs !== record.createdAtMs ||
      !isDeepStrictEqual(currentRecord.expectedIdentity, record.expectedIdentity)
    ) {
      queueDeviceCleanup(requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    const activeRecord = currentRecord;
    if (result.status === "authorized") {
      return await installDeviceTokens(activeRecord, result.tokens);
    }
    if (result.status === "authorization_pending" || result.status === "slow_down") {
      const pollIntervalMs =
        result.status === "slow_down"
          ? Math.min(
              DEVICE_MAX_POLL_INTERVAL_SECONDS * 1_000,
              Math.max(activeRecord.pollIntervalMs + 5_000, (result.intervalSeconds ?? 0) * 1_000),
            )
          : activeRecord.pollIntervalMs;
      const nextPollAtMs = Math.min(activeRecord.expiresAtMs, now + pollIntervalMs);
      writeGitHubDeviceAuthorizationRecord({ ...activeRecord, pollIntervalMs, nextPollAtMs });
      return {
        status: result.status === "slow_down" ? "slow_down" : "pending",
        nextPollAtMs,
      };
    }
    queueDeviceCleanup(requestId);
    if (result.status === "access_denied") {
      return { status: "access_denied" };
    }
    if (result.status === "expired_token") {
      return { status: "expired" };
    }
    if (result.code === "incorrect_device_code" || result.code === "bad_verification_code") {
      return { status: "incorrect_device_code" };
    }
    return { status: "failed", reason: "setup_failed" };
  };

  const refreshOne = async (
    configured: ConfiguredOAuthIdentity,
    recovery?: GitHubOAuthRecord,
  ): Promise<void> => {
    const oldProfileId = recovery?.replacesProfileId ?? configured.identity.profileId;
    const inspected = inspectGitHubOAuthRecord(oldProfileId);
    if (inspected.state !== "valid") {
      return;
    }
    const old = inspected.record;
    const refreshSource = recovery ?? old;
    const now = Date.now();
    if (refreshSource.refreshFailure === "expired" || refreshSource.refreshExpiresAtMs <= now) {
      return;
    }
    if (!recovery && old.accessExpiresAtMs > now + REFRESH_SKEW_MS) {
      return;
    }
    let refreshed;
    try {
      refreshed = await refreshGitHubOAuthToken({
        refreshToken: refreshSource.refreshToken,
        signal: controller.signal,
      });
    } catch {
      writeGitHubOAuthRecord({ ...refreshSource, refreshFailure: "failed" });
      return;
    }
    if (refreshed.status === "error") {
      const refreshFailure = refreshed.code === "bad_refresh_token" ? "expired" : "failed";
      writeGitHubOAuthRecord({
        ...refreshSource,
        refreshFailure,
      });
      if (recovery && refreshFailure === "expired") {
        writeGitHubOAuthRecord({ ...old, refreshFailure: "expired" });
        queueOAuthCleanup(recovery.profileId);
      }
      return;
    }
    const currentIdentity = currentIdentityForRecord(params.getConfig(), old);
    if (currentIdentity?.kind !== "oauth" || currentIdentity.profileId !== oldProfileId) {
      return;
    }
    const profileId = recovery?.profileId ?? createManagedGitHubProfileId();
    let replacementRecord = createGitHubOAuthRecord({
      profileId,
      scope: configured.scope,
      agentId: configured.agentId,
      account: { accountId: old.accountId, login: old.login, avatarUrl: null },
      tokens: refreshed.tokens,
      now: Date.now(),
      replacesProfileId: oldProfileId,
      profilePending: true,
    });
    const finalizeReplacement = () => {
      writeGitHubOAuthRecord({
        ...replacementRecord,
        replacesProfileId: undefined,
        profilePending: undefined,
      });
      queueOAuthCleanup(oldProfileId);
    };
    // Refresh rotates immediately. Persist the new refresh credential before
    // any fallible profile work so maintenance can obtain another access token.
    pendingRotations.set(profileId, replacementRecord);
    writeGitHubOAuthRecord(replacementRecord);
    pendingRotations.delete(profileId);
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: configured.agentId,
      scope: configured.scope,
      profileId,
    });
    let profileReady = false;
    try {
      await installManagedGitHubProfile({
        profileDir,
        token: refreshed.tokens.accessToken,
        retainProfileOnCommitFailure: true,
        commitConfig: async (account) => {
          if (account.accountId !== old.accountId || account.login !== old.login) {
            throw new Error("GitHub OAuth refresh returned a different account.");
          }
          const { profilePending: _profilePending, ...readyRecord } = replacementRecord;
          replacementRecord = {
            ...readyRecord,
            accountId: account.accountId,
            login: account.login,
          };
          writeGitHubOAuthRecord(replacementRecord);
          profileReady = true;
          await updateGitHubToolIdentityConfig({
            scope: configured.scope,
            agentId: configured.agentId,
            identity: {
              profileId,
              kind: "oauth",
              ...(currentIdentity.gitAuthor
                ? { gitAuthor: structuredClone(currentIdentity.gitAuthor) }
                : {}),
            },
            expectedIdentity: currentIdentity,
          });
        },
      });
    } catch {
      let current: GitHubToolIdentityConfig | undefined;
      try {
        current = currentIdentityForRecord(
          params.getPersistedConfig?.() ?? params.getConfig(),
          old,
        );
      } catch {
        return;
      }
      if (current?.profileId === profileId && current.kind === "oauth") {
        finalizeReplacement();
        return;
      }
      if (!isDeepStrictEqual(current, currentIdentity)) {
        queueOAuthCleanup(profileId);
        await removeManagedGitHubProfile(profileDir).catch(() => undefined);
      } else if (!profileReady) {
        await removeManagedGitHubProfile(profileDir).catch(() => undefined);
      }
      return;
    }
    finalizeReplacement();
  };

  const requestRefresh = (
    configured: ConfiguredOAuthIdentity,
    recovery?: GitHubOAuthRecord,
  ): Promise<void> => {
    const refreshKey = recovery?.profileId ?? configured.identity.profileId;
    const existing = refreshes.get(refreshKey);
    if (existing) {
      return existing;
    }
    const operation = refreshOne(configured, recovery)
      .catch((error: unknown) => {
        params.warn(`GitHub OAuth refresh failed; will retry: ${formatErrorMessage(error)}`);
      })
      .finally(() => {
        if (refreshes.get(refreshKey) === operation) {
          refreshes.delete(refreshKey);
        }
      });
    refreshes.set(refreshKey, operation);
    return operation;
  };

  const reconcileRecords = async (): Promise<void> => {
    for (const { requestId, record } of listGitHubDeviceAuthorizationRecords()) {
      if (!record || record.expiresAtMs <= Date.now()) {
        queueDeviceCleanup(requestId);
      }
    }
    for (const { profileId, record } of listGitHubOAuthRecords()) {
      if (!record) {
        queueOAuthCleanup(profileId);
        continue;
      }
      const current = currentIdentityForRecord(params.getConfig(), record);
      if (!record.replacesProfileId) {
        if (current?.profileId !== profileId || current.kind !== "oauth") {
          queueOAuthCleanup(profileId);
        }
        continue;
      }
      if (current?.profileId === profileId) {
        if (record.profilePending) {
          await requestRefresh(
            {
              scope: record.scope,
              agentId: record.agentId,
              identity: { ...current, kind: "oauth" },
            },
            record,
          );
          continue;
        }
        writeGitHubOAuthRecord({ ...record, replacesProfileId: undefined });
        queueOAuthCleanup(record.replacesProfileId);
        continue;
      }
      if (current?.profileId !== record.replacesProfileId || current.kind !== "oauth") {
        queueOAuthCleanup(profileId);
        await removeManagedGitHubProfile(
          resolveManagedGitHubProfileDir({
            agentId: record.agentId,
            scope: record.scope,
            profileId,
          }),
        ).catch(() => undefined);
        continue;
      }
      const candidateDir = resolveManagedGitHubProfileDir({
        agentId: record.agentId,
        scope: record.scope,
        profileId,
      });
      const configured = {
        scope: record.scope,
        agentId: record.agentId,
        identity: { ...current, kind: "oauth" as const },
      };
      if (record.profilePending) {
        await removeManagedGitHubProfile(candidateDir).catch(() => undefined);
        await requestRefresh(configured, record);
        continue;
      }
      if (!(await isPrivateManagedGitHubProfile(candidateDir))) {
        const pendingRecord = { ...record, profilePending: true as const };
        writeGitHubOAuthRecord(pendingRecord);
        await requestRefresh(configured, pendingRecord);
        continue;
      }
      try {
        await updateGitHubToolIdentityConfig({
          scope: record.scope,
          agentId: record.agentId,
          identity: {
            profileId,
            kind: "oauth",
            ...(current.gitAuthor ? { gitAuthor: structuredClone(current.gitAuthor) } : {}),
          },
          expectedIdentity: current,
        });
        writeGitHubOAuthRecord({ ...record, replacesProfileId: undefined });
        queueOAuthCleanup(record.replacesProfileId);
      } catch {
        // The durable replacement record remains for the next maintenance pass.
      }
    }
  };

  const runMaintenance = async (): Promise<void> => {
    for (const requestId of pendingCleanup) {
      queueDeviceCleanup(requestId);
    }
    for (const [profileId, record] of [...pendingRotations].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const current = currentIdentityForRecord(params.getConfig(), record);
      if (current?.kind !== "oauth" || current.profileId !== record.replacesProfileId) {
        pendingRotations.delete(profileId);
        continue;
      }
      try {
        writeGitHubOAuthRecord(record);
        pendingRotations.delete(profileId);
      } catch {
        // Retain the rotated refresh token in memory for the next maintenance pass.
      }
    }
    await reconcileRecords();
    for (const configured of configuredOAuthIdentities(params.getConfig())) {
      await requestRefresh(configured);
    }
  };

  const maintain = (): Promise<void> => {
    if (maintenance) {
      return maintenance;
    }
    maintenance = runMaintenance()
      .catch((error: unknown) => {
        params.warn(`GitHub OAuth maintenance failed; will retry: ${formatErrorMessage(error)}`);
      })
      .finally(() => {
        maintenance = undefined;
      });
    return maintenance;
  };

  return {
    startAuthorization: async (input: {
      scope: GitHubIdentityScope;
      agentId: string;
    }): Promise<ToolsGitHubAuthorizeStartResult> => {
      const expectedIdentity = structuredClone(
        resolveConfiguredGitHubToolIdentity({ config: params.getConfig(), ...input }) ?? null,
      );
      const authorization = await requestGitHubOAuthDeviceCode({ signal: controller.signal });
      if (!identityStillSelected(params.getConfig(), input, expectedIdentity)) {
        throw new Error("GitHub identity changed while authorization was starting.");
      }
      if (
        authorization.expiresInSeconds > DEVICE_MAX_LIFETIME_SECONDS ||
        authorization.intervalSeconds > DEVICE_MAX_POLL_INTERVAL_SECONDS
      ) {
        throw new Error("GitHub device authorization timing is outside the supported bounds.");
      }
      for (const existing of listGitHubDeviceAuthorizationRecords()) {
        if (existing.record?.scope === input.scope && existing.record.agentId === input.agentId) {
          queueDeviceCleanup(existing.requestId);
        }
      }
      const requestId = `github-device-${randomBytes(16).toString("hex")}`;
      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + authorization.expiresInSeconds * 1_000;
      const pollIntervalMs = authorization.intervalSeconds * 1_000;
      const nextPollAtMs = createdAtMs + pollIntervalMs;
      writeGitHubDeviceAuthorizationRecord({
        version: 1,
        requestId,
        deviceCode: authorization.deviceCode,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        createdAtMs,
        expiresAtMs,
        pollIntervalMs,
        nextPollAtMs,
        agentId: input.agentId,
        scope: input.scope,
        expectedIdentity,
      });
      return {
        requestId,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresAtMs,
        pollIntervalMs,
        nextPollAtMs,
      };
    },
    pollAuthorization: (requestId: string): Promise<ToolsGitHubAuthorizePollResult> => {
      const existing = devicePolls.get(requestId);
      if (existing) {
        return existing;
      }
      const operation = pollOnce(requestId).finally(() => {
        if (devicePolls.get(requestId) === operation) {
          devicePolls.delete(requestId);
        }
      });
      devicePolls.set(requestId, operation);
      return operation;
    },
    cancelAuthorization: (requestId: string): boolean => {
      if (committingRequests.has(requestId)) {
        return false;
      }
      const existed = readGitHubDeviceAuthorizationRecord(requestId) !== undefined;
      queueDeviceCleanup(requestId);
      return existed;
    },
    status,
    retireProfile: (profileId: string) => queueOAuthCleanup(profileId),
    refreshEffectiveIdentity: async (agentId: string): Promise<void> => {
      const config = params.getConfig();
      const agent = resolveAgentConfig(config, agentId)?.tools?.github;
      const identity = agent ?? config.tools?.github;
      if (identity?.kind !== "oauth") {
        return;
      }
      await requestRefresh({
        scope: agent ? "agent" : "system",
        agentId,
        identity: { ...identity, kind: "oauth" },
      });
    },
    maintain,
    start: () => {
      void maintain();
      interval ??= setInterval(() => void maintain(), MAINTENANCE_INTERVAL_MS);
      interval.unref?.();
    },
    stop: async () => {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      controller.abort();
      await Promise.allSettled([
        ...(maintenance ? [maintenance] : []),
        ...devicePolls.values(),
        ...refreshes.values(),
      ]);
    },
  };
}
