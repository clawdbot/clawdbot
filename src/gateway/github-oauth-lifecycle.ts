import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ToolsGitHubAuthorizePollResult,
  ToolsGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../agents/agent-lifecycle-registry.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
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
import type { GitHubToolAccount } from "../agents/github-tool-account.js";
import {
  createManagedGitHubProfileId,
  GitHubAccountMismatchError,
  installManagedGitHubProfile,
  refreshManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  authorizationStillOwned,
  configuredOAuthIdentities,
  currentIdentityForRecord,
  defaultGitAuthor,
  DEVICE_MAX_LIFETIME_SECONDS,
  DEVICE_MAX_POLL_INTERVAL_SECONDS,
  identityStillSelected,
  MAINTENANCE_INTERVAL_MS,
  REFRESH_SKEW_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  type ConfiguredOAuthIdentity,
} from "./github-oauth-lifecycle-helpers.js";
import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

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

export function createGitHubOAuthLifecycle(params: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig?: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  const deviceController = new AbortController();
  const devicePolls = new Map<string, Promise<ToolsGitHubAuthorizePollResult>>();
  const committingRequests = new Set<string>();
  const refreshes = new Map<string, Promise<void>>();
  const pendingRefreshes = new Map<
    string,
    { record: GitHubOAuthRecord & { pendingRefresh: true }; accessToken: string }
  >();
  const pendingCleanup = new Set<string>();
  let maintenance: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

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
    if (!authorizationStillOwned(current, record)) {
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
            !authorizationStillOwned(params.getConfig(), record)
          ) {
            throw new Error("GitHub authorization is no longer pending.");
          }
          committingRequests.add(record.requestId);
          const pendingInitial = {
            requestId: record.requestId,
            scope: record.scope,
            agentId: record.agentId,
            expectedIdentity: record.expectedIdentity,
            ...(record.agentLifecycleBinding
              ? { agentLifecycleBinding: record.agentLifecycleBinding }
              : {}),
          } as const;
          writeGitHubOAuthRecord(
            createGitHubOAuthRecord({
              profileId,
              scope: record.scope,
              agentId: record.agentId,
              account,
              tokens,
              now: Date.now(),
              pendingInitial,
            }),
          );
          metadataWritten = true;
          const identity: GitHubToolIdentityConfig = {
            profileId,
            kind: "oauth",
            gitAuthor: record.expectedIdentity?.gitAuthor
              ? structuredClone(record.expectedIdentity.gitAuthor)
              : defaultGitAuthor(account),
          };
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: record.scope,
            agentId: record.agentId,
            identity,
            expectedIdentity: record.expectedIdentity,
            ...(record.agentLifecycleBinding
              ? { agentLifecycleBinding: record.agentLifecycleBinding }
              : {}),
          });
          const inspected = inspectGitHubOAuthRecord(profileId);
          if (inspected.state !== "valid" || !inspected.record.pendingInitial) {
            throw new Error("GitHub OAuth initial record is unavailable.");
          }
          writeGitHubOAuthRecord({ ...inspected.record, pendingInitial: undefined });
        },
      });
    } catch {
      if (metadataWritten) {
        try {
          const persistedConfig = params.getPersistedConfig?.();
          if (!persistedConfig) {
            throw new Error("Authoritative persisted config is unavailable.");
          }
          const persistedIdentity = resolveConfiguredGitHubToolIdentity({
            config: persistedConfig,
            scope: record.scope,
            agentId: record.agentId,
          });
          if (persistedIdentity?.profileId === profileId && persistedIdentity.kind === "oauth") {
            const inspected = inspectGitHubOAuthRecord(profileId);
            if (inspected.state === "valid" && inspected.record.pendingInitial) {
              writeGitHubOAuthRecord({ ...inspected.record, pendingInitial: undefined });
            }
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
    if (!authorizationStillOwned(params.getConfig(), record)) {
      queueDeviceCleanup(requestId);
      return { status: "failed", reason: "identity_changed" };
    }
    if (now < record.nextPollAtMs) {
      return { status: "pending", retryAfterMs: record.nextPollAtMs - now };
    }
    let result;
    try {
      result = await pollGitHubOAuthDeviceToken({
        deviceCode: record.deviceCode,
        signal: deviceController.signal,
      });
    } catch {
      const currentRecord = readGitHubDeviceAuthorizationRecord(requestId);
      if (!currentRecord) {
        return { status: "expired" };
      }
      const retryAtMs = Math.min(currentRecord.expiresAtMs, now + currentRecord.pollIntervalMs);
      writeGitHubDeviceAuthorizationRecord({ ...currentRecord, nextPollAtMs: retryAtMs });
      return { status: "network_error", retryAfterMs: Math.max(1, retryAtMs - now) };
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
        retryAfterMs: Math.max(1, nextPollAtMs - now),
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

  const applyPendingRefresh = async (
    record: GitHubOAuthRecord & { pendingRefresh: true },
    accessToken: string,
  ): Promise<void> => {
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: record.agentId,
      scope: record.scope,
      profileId: record.profileId,
    });
    let account: GitHubToolAccount;
    try {
      account = await refreshManagedGitHubProfile({
        profileDir,
        token: accessToken,
        expectedAccountId: record.accountId,
      });
    } catch (error) {
      if (error instanceof GitHubAccountMismatchError) {
        writeGitHubOAuthRecord({
          ...record,
          pendingRefresh: undefined,
          refreshFailure: "expired",
        });
      }
      return;
    }
    writeGitHubOAuthRecord({
      ...record,
      login: account.login,
      pendingRefresh: undefined,
      refreshFailure: undefined,
    });
  };

  const refreshOne = async (configured: ConfiguredOAuthIdentity): Promise<void> => {
    const profileId = configured.identity.profileId;
    const inspected = inspectGitHubOAuthRecord(profileId);
    if (inspected.state !== "valid") {
      return;
    }
    const currentRecord = inspected.record;
    if (currentRecord.pendingInitial) {
      return;
    }
    const now = Date.now();
    if (currentRecord.refreshFailure === "expired" || currentRecord.refreshExpiresAtMs <= now) {
      return;
    }
    if (!currentRecord.pendingRefresh && currentRecord.accessExpiresAtMs > now + REFRESH_SKEW_MS) {
      return;
    }
    const currentIdentity = currentIdentityForRecord(params.getConfig(), currentRecord);
    if (currentIdentity?.kind !== "oauth" || currentIdentity.profileId !== profileId) {
      return;
    }
    let refreshed;
    try {
      refreshed = await refreshGitHubOAuthToken({
        refreshToken: currentRecord.refreshToken,
      });
    } catch {
      if (!currentRecord.pendingRefresh) {
        writeGitHubOAuthRecord({ ...currentRecord, refreshFailure: "failed" });
      }
      return;
    }
    if (refreshed.status === "error") {
      const refreshFailure = refreshed.code === "bad_refresh_token" ? "expired" : "failed";
      writeGitHubOAuthRecord({
        ...currentRecord,
        pendingRefresh: undefined,
        refreshFailure,
      });
      return;
    }
    const rotatedRecord: GitHubOAuthRecord & { pendingRefresh: true } = {
      ...currentRecord,
      refreshToken: refreshed.tokens.refreshToken,
      accessExpiresAtMs: now + refreshed.tokens.expiresInSeconds * 1_000,
      refreshExpiresAtMs: now + refreshed.tokens.refreshTokenExpiresInSeconds * 1_000,
      scopes: refreshed.tokens.scopes,
      pendingRefresh: true,
      pendingInitial: undefined,
      refreshFailure: undefined,
    };
    pendingRefreshes.set(profileId, {
      record: rotatedRecord,
      accessToken: refreshed.tokens.accessToken,
    });
    try {
      writeGitHubOAuthRecord(rotatedRecord);
    } catch {
      return;
    }
    pendingRefreshes.delete(profileId);
    await applyPendingRefresh(rotatedRecord, refreshed.tokens.accessToken);
  };

  const requestRefresh = (configured: ConfiguredOAuthIdentity): Promise<void> => {
    const refreshKey = configured.identity.profileId;
    const existing = refreshes.get(refreshKey);
    if (existing) {
      return existing;
    }
    const operation = refreshOne(configured)
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
      if (record.pendingInitial) {
        if (committingRequests.has(record.pendingInitial.requestId)) {
          continue;
        }
        let persistedConfig: OpenClawConfig;
        try {
          const persisted = params.getPersistedConfig?.();
          if (!persisted) {
            continue;
          }
          persistedConfig = persisted;
        } catch {
          continue;
        }
        const persistedIdentity = currentIdentityForRecord(persistedConfig, record);
        const agentBindingMatches =
          record.scope === "system" ||
          (record.pendingInitial.agentLifecycleBinding !== undefined &&
            matchesAgentLifecycleBinding(
              persistedConfig,
              record.pendingInitial.agentLifecycleBinding,
            ));
        if (
          agentBindingMatches &&
          persistedIdentity?.profileId === profileId &&
          persistedIdentity.kind === "oauth"
        ) {
          writeGitHubOAuthRecord({ ...record, pendingInitial: undefined });
          if (record.pendingInitial.expectedIdentity?.kind === "oauth") {
            queueOAuthCleanup(record.pendingInitial.expectedIdentity.profileId);
          }
          continue;
        }
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
      const current = currentIdentityForRecord(params.getConfig(), record);
      if (current?.profileId !== profileId || current.kind !== "oauth") {
        queueOAuthCleanup(profileId);
        continue;
      }
      if (record.pendingRefresh && !stopping) {
        await requestRefresh({
          scope: record.scope,
          agentId: record.agentId,
          identity: { ...current, kind: "oauth" },
        });
      }
    }
  };

  const runMaintenance = async (): Promise<void> => {
    for (const requestId of pendingCleanup) {
      queueDeviceCleanup(requestId);
    }
    for (const [profileId, pending] of [...pendingRefreshes].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      try {
        writeGitHubOAuthRecord(pending.record);
        pendingRefreshes.delete(profileId);
        await applyPendingRefresh(pending.record, pending.accessToken);
      } catch {
        // Retain the rotated refresh token in memory for the next maintenance pass.
      }
    }
    await reconcileRecords();
    for (const configured of configuredOAuthIdentities(params.getConfig())) {
      if (stopping) {
        break;
      }
      await requestRefresh(configured);
    }
  };

  const maintain = (): Promise<void> => {
    if (stopping && !maintenance) {
      return Promise.resolve();
    }
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
      if (stopping) {
        throw new Error("GitHub authorization lifecycle is stopping.");
      }
      const expectedIdentity = structuredClone(
        resolveConfiguredGitHubToolIdentity({ config: params.getConfig(), ...input }) ?? null,
      );
      const agentLifecycleBinding =
        input.scope === "agent"
          ? captureAgentLifecycleBinding(params.getConfig(), input.agentId)
          : undefined;
      if (input.scope === "agent" && !agentLifecycleBinding) {
        throw new Error("GitHub authorization requires an active agent.");
      }
      const authorization = await requestGitHubOAuthDeviceCode({ signal: deviceController.signal });
      if (
        !identityStillSelected(params.getConfig(), input, expectedIdentity) ||
        (agentLifecycleBinding !== undefined &&
          !matchesAgentLifecycleBinding(params.getConfig(), agentLifecycleBinding))
      ) {
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
        ...(agentLifecycleBinding ? { agentLifecycleBinding } : {}),
      });
      return {
        requestId,
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresInMs: authorization.expiresInSeconds * 1_000,
        pollAfterMs: pollIntervalMs,
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
      if (stopping) {
        return;
      }
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
      if (stopping) {
        return;
      }
      void maintain();
      interval ??= setInterval(() => void maintain(), MAINTENANCE_INTERVAL_MS);
      interval.unref?.();
    },
    stop: async () => {
      stopping = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      deviceController.abort();
      const drain = (async () => {
        await Promise.allSettled([
          ...(maintenance ? [maintenance] : []),
          ...devicePolls.values(),
          ...refreshes.values(),
        ]);
        if (pendingRefreshes.size > 0) {
          await runMaintenance();
        }
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          drain,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    },
  };
}
