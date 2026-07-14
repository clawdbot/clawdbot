// Gateway WebSocket node connects reconcile the approved command/capability surface.
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  requestNodePairing,
} from "../../../infra/node-pairing.js";
import { AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING } from "../../auth-rate-limit.js";
import { ADMIN_SCOPE, PAIRING_SCOPE, WRITE_SCOPE } from "../../method-scopes.js";
import { filterLegacyNodeProtocolFeatures } from "../../node-command-policy.js";
import { reconcileNodePairingOnConnect } from "../../node-connect-reconcile.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

class NodePairingRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("node pairing rate limited");
  }
}

async function requestNodePairingFromConnect(params: {
  input: Parameters<typeof requestNodePairing>[0];
  rateLimiter?: import("../../auth-rate-limit.js").AuthRateLimiter;
  clientIp?: string;
  pairedReconnect?: boolean;
  cleanupClaim?: import("../../../infra/node-pairing.js").NodePairingCleanupClaim;
  reapprovalCoordinator?: import("../../node-reapproval-coordinator.js").NodeReapprovalCoordinator;
}): Promise<Awaited<ReturnType<typeof requestNodePairing>> | null> {
  if (params.pairedReconnect) {
    return params.reapprovalCoordinator
      ? await params.reapprovalCoordinator.request({
          input: params.input,
          cleanupClaim: params.cleanupClaim,
        })
      : await requestNodePairing(params.input);
  }
  if (!params.rateLimiter) {
    return await requestNodePairing(params.input);
  }
  return await withSerializedRateLimitAttempt({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
      );
      if (rateCheck && !rateCheck.allowed) {
        throw new NodePairingRateLimitError(rateCheck.retryAfterMs);
      }
      const result = await requestNodePairing(params.input);
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING);
      return result;
    },
  });
}

export async function prepareGatewayNodeConnect(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
): Promise<boolean> {
  if (state.role !== "node") {
    return true;
  }
  const {
    pluginNodeCapabilities = [],
    nodeReapprovalCoordinator,
    buildRequestContext,
    logGateway,
  } = context.handler;
  const {
    connectParams,
    reportedClientIp,
    authRateLimiter,
    browserRateLimitClientIp,
    pendingNodePairingCleanup,
    releasePendingNodePairingCleanup,
    broadcastNodePairingResult,
  } = context;
  const { device, devicePublicKey, usesLegacyNodeProtocol, rejectUnauthorized } = state;
  const nodeId = connectParams.device?.id ?? connectParams.client.id;
  const nodePairingSnapshot = await beginNodePairingConnect(nodeId);
  const pairedNode = nodePairingSnapshot.pairedNode;
  pendingNodePairingCleanup.value = nodePairingSnapshot.cleanupClaim;
  // Re-read the device record: how device pairing was approved decides
  // whether the first capability surface may be marked silent.
  const pairedDeviceForSurface =
    device && devicePublicKey ? await getPairedDevice(device.id) : null;
  const deviceApprovedVia =
    pairedDeviceForSurface?.publicKey === devicePublicKey
      ? pairedDeviceForSurface?.approvedVia
      : undefined;
  // Only device approvals that carry a proof stronger than network
  // origin may hint silent capability approval: "silent" (same-host
  // local), "ssh-verified" (device-key match over SSH), "bootstrap"
  // (owner setup code). "trusted-cidr" proves only that the device came
  // from an allowed network, which must not silently approve its
  // command/capability surface.
  const deviceApprovedNonInteractively =
    deviceApprovedVia === "silent" ||
    deviceApprovedVia === "ssh-verified" ||
    deviceApprovedVia === "bootstrap";
  let reconciliation: Awaited<ReturnType<typeof reconcileNodePairingOnConnect>>;
  try {
    reconciliation = await reconcileNodePairingOnConnect({
      cfg: getRuntimeConfig(),
      connectParams,
      pairedNode,
      reportedClientIp,
      initialSurfaceSilent: deviceApprovedNonInteractively,
      requestPairing: async (input) => {
        return await requestNodePairingFromConnect({
          input,
          rateLimiter: authRateLimiter,
          clientIp: browserRateLimitClientIp,
          pairedReconnect: pairedNode !== null,
          cleanupClaim: pendingNodePairingCleanup.value,
          reapprovalCoordinator: nodeReapprovalCoordinator,
        });
      },
    });
  } catch (error) {
    await releasePendingNodePairingCleanup();
    if (error instanceof NodePairingRateLimitError) {
      rejectUnauthorized({
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: error.retryAfterMs,
      });
      return false;
    }
    throw error;
  }
  // The ssh-verify key match already proved this node runs under the
  // operator's account on a machine they own, which is the same claim
  // a manual capability approval asserts; approve the first declared
  // surface directly. Surface upgrades still prompt.
  if (deviceApprovedVia === "ssh-verified" && !pairedNode && reconciliation.pendingPairing) {
    const surfaceRequestId = reconciliation.pendingPairing.request.requestId;
    const approvedSurface = await approveNodePairing(surfaceRequestId, {
      callerScopes: [ADMIN_SCOPE, PAIRING_SCOPE, WRITE_SCOPE],
    });
    if (approvedSurface && "node" in approvedSurface) {
      logGateway.info(
        `security audit: node capability surface ssh-verified auto-approve node=${reconciliation.nodeId} commands=${reconciliation.declaredCommands.join(",") || "<none>"}`,
      );
      buildRequestContext().broadcast(
        "node.pair.resolved",
        {
          requestId: surfaceRequestId,
          nodeId: reconciliation.nodeId,
          decision: "approved",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      reconciliation = {
        ...reconciliation,
        effectiveCaps: reconciliation.declaredCaps,
        effectiveCommands: reconciliation.declaredCommands,
        effectivePermissions: reconciliation.declaredPermissions,
        pendingPairing: undefined,
        shouldClearPendingPairings: true,
      };
    }
  }
  if (!reconciliation.shouldClearPendingPairings) {
    await releasePendingNodePairingCleanup();
  }
  if (reconciliation.pendingPairing) {
    broadcastNodePairingResult(reconciliation.pendingPairing);
  }
  const nodeConnectParams = connectParams as ConnectParams & {
    declaredCaps?: string[];
    declaredCommands?: string[];
    declaredPermissions?: Record<string, boolean>;
    sessionCapsCeiling?: string[];
    sessionCommandsCeiling?: string[];
  };
  nodeConnectParams.declaredCaps = reconciliation.declaredCaps;
  nodeConnectParams.declaredCommands = reconciliation.declaredCommands;
  nodeConnectParams.declaredPermissions = reconciliation.declaredPermissions;
  const pluginSurfaces = pluginNodeCapabilities.map((surface) => surface.surface);
  if (usesLegacyNodeProtocol) {
    const sessionCeiling = filterLegacyNodeProtocolFeatures({
      caps: reconciliation.declaredCaps,
      commands: reconciliation.declaredCommands,
      pluginSurfaces,
    });
    nodeConnectParams.sessionCapsCeiling = sessionCeiling.caps;
    nodeConnectParams.sessionCommandsCeiling = sessionCeiling.commands;
  }
  const effectiveFeatures = usesLegacyNodeProtocol
    ? filterLegacyNodeProtocolFeatures({
        caps: reconciliation.effectiveCaps,
        commands: reconciliation.effectiveCommands,
        pluginSurfaces,
      })
    : {
        caps: reconciliation.effectiveCaps,
        commands: reconciliation.effectiveCommands,
      };
  connectParams.caps = effectiveFeatures.caps;
  connectParams.commands = effectiveFeatures.commands;
  connectParams.permissions = reconciliation.effectivePermissions;
  return true;
}
