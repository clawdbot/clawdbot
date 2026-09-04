// Coordinates paired-node reapproval requests before they enter pairing storage.
import type { GatewayAuthRateLimitConfig } from "../config/types.gateway.js";
import {
  finalizeNodePairingCleanupClaim,
  requestNodePairing,
  reusePendingNodePairingForReconnect,
  type NodePairingCleanupClaim,
  type NodePairingRequestInput,
  type NodePairingSupersededRequest,
  type RequestNodePairingResult,
} from "../infra/device-pairing-node.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL,
  buildRateLimitIdentityKey,
  createAuthRateLimiter,
  type RateLimitConfig,
} from "./auth-rate-limit.js";

const pendingNodeReapprovalAttempts = new KeyedAsyncQueue();

type ReapprovalRequestParams = {
  input: NodePairingRequestInput;
  cleanupClaim?: NodePairingCleanupClaim;
  baseDir?: string;
};

type DeferredResult = Deferred<RequestNodePairingResult | null>;

type QueuedRequest = {
  fingerprint: string;
  params: ReapprovalRequestParams;
  deferred: DeferredResult;
  followers: DeferredResult[];
};

type NodeRequestState = {
  queued?: QueuedRequest;
};

export type NodeReapprovalCoordinator = {
  request: (params: ReapprovalRequestParams) => Promise<RequestNodePairingResult | null>;
  finalizeCleanup: (claim: NodePairingCleanupClaim) => Promise<NodePairingSupersededRequest[]>;
  dispose: () => void;
};

function normalizeFingerprintList(value: string[] | undefined): string[] | undefined {
  return value
    ? [
        ...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
      ].toSorted()
    : undefined;
}

function buildRequestFingerprint(input: NodePairingRequestInput): string {
  const permissions = input.permissions
    ? Object.fromEntries(
        Object.entries(input.permissions).toSorted(([left], [right]) => left.localeCompare(right)),
      )
    : undefined;
  return JSON.stringify({
    nodeId: input.nodeId.trim(),
    clientId: input.clientId,
    clientMode: input.clientMode,
    displayName: input.displayName,
    platform: input.platform,
    version: input.version,
    coreVersion: input.coreVersion,
    uiVersion: input.uiVersion,
    deviceFamily: input.deviceFamily,
    modelIdentifier: input.modelIdentifier,
    caps: normalizeFingerprintList(input.caps),
    commands: normalizeFingerprintList(input.commands),
    permissions,
    remoteIp: input.remoteIp,
    silent: Boolean(input.silent),
  });
}

/** Creates the gateway-lifetime owner for paired-node reapproval write limits. */
export function createNodeReapprovalCoordinator(
  config?: RateLimitConfig,
): NodeReapprovalCoordinator & {
  updateConfig: (config?: GatewayAuthRateLimitConfig) => void;
} {
  const limiter = createAuthRateLimiter({
    ...config,
    exemptLoopback: false,
  });
  const requestStates = new Map<string, NodeRequestState>();
  let disposed = false;

  const executeRequest = async ({
    input,
    cleanupClaim,
    baseDir,
  }: ReapprovalRequestParams): Promise<RequestNodePairingResult | null> => {
    if (disposed) {
      return null;
    }
    const reused = await reusePendingNodePairingForReconnect(input, cleanupClaim, baseDir);
    if (reused) {
      return reused;
    }

    const nodeId = input.nodeId.trim();
    const identityKey = buildRateLimitIdentityKey("node", nodeId);
    const rateCheck = limiter.check(identityKey, AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL);
    if (!rateCheck.allowed) {
      return null;
    }
    const result = await requestNodePairing(input, baseDir);
    limiter.recordFailure(identityKey, AUTH_RATE_LIMIT_SCOPE_NODE_REAPPROVAL);
    return result;
  };

  const enqueueRequest = (
    nodeId: string,
    state: NodeRequestState,
    initial?: QueuedRequest,
  ): void => {
    void pendingNodeReapprovalAttempts.enqueue(`node-reapproval:${nodeId}`, async () => {
      const queued = initial ?? state.queued;
      if (!initial) {
        state.queued = undefined;
      }
      if (!queued) {
        return;
      }
      try {
        queued.deferred.resolve(await executeRequest(queued.params));
        for (const follower of queued.followers) {
          follower.resolve(null);
        }
      } catch (error) {
        queued.deferred.reject(error);
        for (const follower of queued.followers) {
          follower.reject(error);
        }
      } finally {
        if (requestStates.get(nodeId) === state && !state.queued) {
          requestStates.delete(nodeId);
        }
      }
    });
  };

  return {
    updateConfig: (next) => limiter.updateConfig({ ...next, exemptLoopback: false }),
    request(params) {
      if (disposed) {
        return Promise.resolve(null);
      }
      const nodeId = params.input.nodeId.trim();
      const fingerprint = buildRequestFingerprint(params.input);
      const state = requestStates.get(nodeId);
      if (!state) {
        const deferred = createDeferredCore<RequestNodePairingResult | null>();
        const nextState: NodeRequestState = {};
        requestStates.set(nodeId, nextState);
        enqueueRequest(nodeId, nextState, {
          fingerprint,
          params,
          deferred,
          followers: [],
        });
        return deferred.promise;
      }
      if (state.queued?.fingerprint === fingerprint) {
        const follower = createDeferredCore<RequestNodePairingResult | null>();
        state.queued.params = params;
        state.queued.followers.push(follower);
        return follower.promise;
      }

      const deferred = createDeferredCore<RequestNodePairingResult | null>();
      if (state.queued) {
        state.queued.deferred.resolve(null);
        for (const follower of state.queued.followers) {
          follower.resolve(null);
        }
        state.queued = { fingerprint, params, deferred, followers: [] };
      } else {
        state.queued = { fingerprint, params, deferred, followers: [] };
        enqueueRequest(nodeId, state);
      }
      return deferred.promise;
    },
    async finalizeCleanup(claim) {
      return await pendingNodeReapprovalAttempts.enqueue(
        `node-reapproval:${claim.nodeId}`,
        async () => await finalizeNodePairingCleanupClaim(claim),
      );
    },
    dispose() {
      disposed = true;
      for (const state of requestStates.values()) {
        state.queued?.deferred.resolve(null);
        for (const follower of state.queued?.followers ?? []) {
          follower.resolve(null);
        }
      }
      requestStates.clear();
      limiter.dispose();
    },
  };
}
