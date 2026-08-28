import {
  GatewayProtocolRequestTimeoutError,
  getGatewaySessionMessageSubscriptionCoordinator,
  releaseGatewaySessionMessageSubscription,
  resetGatewaySessionMessageSubscriptionCoordinator,
} from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SessionBranch,
  SessionCompactionCheckpoint,
  SessionsBranchesSwitchResult,
  SessionsCompactionBranchResult,
  SessionsCompactionRestoreResult,
  SessionsForkResult,
  SessionsRewindResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
  SessionWorkspaceSetResult,
} from "../../api/types.ts";
import { requestSessionRecovery } from "./recover.ts";
import type {
  SessionCompactResult,
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionMessageSubscription,
} from "./session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "./session-key.ts";
import {
  requestSessionBranchSwitch,
  requestSessionBranches,
  requestSessionCheckpointBranch,
  requestSessionCheckpointRestore,
  requestSessionCheckpoints,
  requestSessionCompact,
  requestSessionFile,
  requestSessionFilesList,
  requestSessionFileSet,
  requestSessionFork,
  requestSessionRewind,
} from "./session-requests.ts";

type SessionScopedOperationsHost = {
  connection: SessionConnectionOwner;
  agentId: () => string | null;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  notifyCreated: (key: string) => void;
  reportError: (error: unknown) => void;
};

const retiredFailedSubscriptionRecoveries = new WeakSet<AggregateError>();

export function createSessionScopedOperations(host: SessionScopedOperationsHost) {
  const ownedSubscriptions = new Set<SessionMessageSubscription>();

  const recover = async (params: { key: string; agentId?: string }) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const result = await requestSessionRecovery(scope.client, params);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      host.notifyCreated(result.key);
      await host.refreshReplacement(params.agentId);
      return host.connection.isCurrent(scope) ? result : null;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.reportError(error);
      }
      return null;
    }
  };

  const compact = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session compaction requires an active Gateway connection");
    }
    const result = await requestSessionCompact(scope.client, key, options);
    if (!host.connection.isCurrent(scope)) {
      throw new Error("Session compaction completed on a replaced Gateway connection");
    }
    return result;
  };

  const listFiles = async (
    key: string,
    options: { agentId?: string | null; path?: string; search?: string } = {},
  ): Promise<SessionWorkspaceListResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFilesList(scope.client, key, options);
    return host.connection.isCurrent(scope) ? result : null;
  };

  const getFile = async (
    key: string,
    path: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionWorkspaceGetResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFile(scope.client, key, path, options);
    return host.connection.isCurrent(scope) ? result : null;
  };

  const setFile = async (
    key: string,
    path: string,
    content: string,
    options: { agentId?: string | null; expectedHash: string },
  ): Promise<SessionWorkspaceSetResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const result = await requestSessionFileSet(scope.client, key, path, content, options);
    return host.connection.isCurrent(scope) ? result : null;
  };

  const unsubscribeMessages = async (subscription: SessionMessageSubscription): Promise<void> => {
    await releaseGatewaySessionMessageSubscription(subscription);
    ownedSubscriptions.delete(subscription);
  };

  const subscribeMessages = async (
    key: string,
    options: { agentId?: string | null; includeApprovals?: boolean } = {},
  ): Promise<SessionMessageSubscription> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session message subscription requires an active Gateway connection");
    }
    const normalizedKey = key.trim();
    const agentId =
      isUiGlobalSessionKey(normalizedKey) && options.agentId?.trim()
        ? normalizeAgentId(options.agentId)
        : null;
    const subscription = await getGatewaySessionMessageSubscriptionCoordinator(scope.client, {
      keysEquivalent: areUiSessionKeysEquivalent,
    })
      .acquire(normalizedKey, {
        agentId,
        ...(options.includeApprovals ? { includeApprovals: true } : {}),
      })
      .catch((error: unknown) => {
        if (
          error instanceof AggregateError &&
          error.errors[0] instanceof GatewayProtocolRequestTimeoutError &&
          error.errors[0].requestSent &&
          host.connection.isCurrent(scope) &&
          !retiredFailedSubscriptionRecoveries.has(error)
        ) {
          // Failed compensation cannot prove privileged observers were removed;
          // closing their owning socket invokes authoritative Gateway cleanup.
          retiredFailedSubscriptionRecoveries.add(error);
          scope.client.forceReconnect("session subscription recovery failed");
        }
        throw error;
      });
    ownedSubscriptions.add(subscription);
    if (!host.connection.isCurrent(scope)) {
      await unsubscribeMessages(subscription).catch(() => undefined);
      throw new Error("Session message subscription completed on a replaced Gateway connection");
    }
    return subscription;
  };

  const listCheckpoints = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactionCheckpoint[]> => {
    const scope = host.connection.capture();
    if (!scope) {
      return [];
    }
    const result = await requestSessionCheckpoints(scope.client, key, options);
    return host.connection.isCurrent(scope) ? (result.checkpoints ?? []) : [];
  };

  const checkpointMutation = async <T>(
    key: string,
    checkpointId: string,
    options: { agentId?: string | null },
    request: (
      client: GatewayBrowserClient,
      key: string,
      checkpointId: string,
      options: { agentId?: string | null },
    ) => Promise<T>,
  ): Promise<T> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session checkpoint operation requires an active Gateway connection");
    }
    const result = await request(scope.client, key, checkpointId, options);
    if (!host.connection.isCurrent(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    await host.refreshReplacement(options.agentId ?? host.agentId() ?? undefined);
    if (!host.connection.isCurrent(scope)) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway connection");
    }
    return result;
  };

  const branchCheckpoint = (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionBranchResult> =>
    checkpointMutation(key, checkpointId, options, requestSessionCheckpointBranch);

  const restoreCheckpoint = (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionRestoreResult> =>
    checkpointMutation(key, checkpointId, options, requestSessionCheckpointRestore);

  const reconcileCommittedMutation = async (
    scope: SessionConnectionScope,
    agentId?: string | null,
  ) => {
    // The gateway response commits destructive work; refresh is connection-scoped
    // best effort and must never turn that commit into uncertainty or a retry.
    if (host.connection.isCurrent(scope)) {
      await host.refreshReplacement(agentId ?? host.agentId() ?? undefined).catch(() => {});
    }
  };

  const rewind = async (
    key: string,
    entryId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsRewindResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session rewind requires an active Gateway connection");
    }
    const result = await requestSessionRewind(scope.client, key, entryId, options);
    await reconcileCommittedMutation(scope, options.agentId);
    return result;
  };

  const forkAtMessage = async (
    key: string,
    entryId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsForkResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session fork requires an active Gateway connection");
    }
    const result = await requestSessionFork(scope.client, key, entryId, options);
    await reconcileCommittedMutation(scope, options.agentId);
    return result;
  };

  const listBranches = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionBranch[]> => {
    const scope = host.connection.capture();
    if (!scope) {
      return [];
    }
    const branches = await requestSessionBranches(scope.client, key, options);
    return host.connection.isCurrent(scope) ? branches : [];
  };

  const switchBranch = async (
    key: string,
    leafEntryId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsBranchesSwitchResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      throw new Error("Session branch switch requires an active Gateway connection");
    }
    const result = await requestSessionBranchSwitch(scope.client, key, leafEntryId, options);
    await reconcileCommittedMutation(scope, options.agentId);
    return result;
  };

  return {
    branchCheckpoint,
    compact,
    forkAtMessage,
    getFile,
    listBranches,
    listCheckpoints,
    listFiles,
    recover,
    restoreCheckpoint,
    rewind,
    setFile,
    subscribeMessages,
    switchBranch,
    unsubscribeMessages,
    retireConnection(previousClient: GatewayBrowserClient | null) {
      if (previousClient) {
        resetGatewaySessionMessageSubscriptionCoordinator(previousClient);
      }
      ownedSubscriptions.clear();
    },
    dispose() {
      for (const subscription of ownedSubscriptions) {
        void unsubscribeMessages(subscription).catch(() => undefined);
      }
    },
  };
}
