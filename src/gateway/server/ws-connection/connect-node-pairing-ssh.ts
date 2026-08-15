import type { ConnectPairingRequiredReason } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
// Gateway WebSocket node pairing can finish a fresh capability-free request over SSH.
import { approveDevicePairing, getPairedDevice } from "../../../infra/device-pairing.js";
import {
  planNodePairingSshVerify,
  startNodePairingSshVerify,
} from "../../node-pairing-ssh-verify.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PairingRequest = Awaited<
  ReturnType<typeof import("../../../infra/device-pairing.js").requestDevicePairing>
>;

export function startGatewayNodePairingSshApproval(params: {
  context: GatewayConnectPhaseContext;
  state: AuthenticatedGatewayConnect;
  pairing: PairingRequest;
  existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null;
  devicePublicKey: string;
  clientAccessMetadata: {
    displayName?: string;
    remoteIp?: string;
    lastSeenAtMs: number;
    lastSeenReason: string;
  };
  reason: ConnectPairingRequiredReason;
}): boolean {
  const { context, state, pairing, existingPairedDevice, devicePublicKey, clientAccessMetadata } =
    params;
  const {
    connectParams,
    configSnapshot,
    reportedClientIp,
    reportedClientIpSource,
    hasBrowserOriginHeader,
    runDetachedConnectWork,
  } = context;
  const { connId, buildRequestContext, logGateway } = context.handler;
  const { device, role, scopes, isControlUi, isWebchat } = state;
  if (!device || pairing.request.silent === true) {
    return false;
  }
  // Gate on the request actually being approved, not just this
  // connect's params: requestDevicePairing can refresh an older
  // pending request in place (incomingApprovalCoveredByExisting), so a
  // device could seed a scoped pending request, then reconnect
  // scopeless from an SSH-verifiable host. SSH auto-approval must stay
  // limited to a fresh node request that carries no roles/scopes
  // beyond node.
  const pendingReq = pairing.request;
  const pendingIsFreshScopelessNode =
    (pendingReq.scopes ?? []).length === 0 &&
    (pendingReq.role === undefined || pendingReq.role === "node") &&
    (pendingReq.roles ?? []).every((pendingRole) => pendingRole === "node");
  if (!pendingIsFreshScopelessNode) {
    return false;
  }
  const sshVerifyPlan = planNodePairingSshVerify({
    config: configSnapshot.gateway?.nodes?.pairing?.sshVerify,
    eligibility: {
      existingPairedDevice: Boolean(existingPairedDevice),
      role,
      reason: params.reason,
      scopes,
      hasBrowserOriginHeader,
      isControlUi,
      isWebchat,
      reportedClientIpSource,
      reportedClientIp,
    },
  });
  const sshVerify = sshVerifyPlan
    ? startNodePairingSshVerify({
        plan: sshVerifyPlan,
        expectedDeviceId: device.id,
        expectedPublicKey: devicePublicKey,
      })
    : null;
  // A reconnect during an in-flight probe keeps the retry hint
  // below but must not attach a second approval tail.
  if (sshVerifyPlan && sshVerify && !sshVerify.alreadyInFlight) {
    const pendingRequestId = pairing.request.requestId;
    runDetachedConnectWork(
      async () => {
        const outcome = await sshVerify.done;
        if (!outcome.ok) {
          logGateway.info(
            `node pairing ssh-verify did not approve device=${device.id} host=${sshVerifyPlan.host} reason=${outcome.reason}`,
          );
          return;
        }
        // Approving the pending requestId keeps this race-safe: a
        // superseded or owner-resolved request simply returns null.
        const approvedBySsh = await approveDevicePairing(pendingRequestId, {
          callerScopes: scopes,
          accessMetadata: clientAccessMetadata,
          approvedVia: "ssh-verified",
        });
        if (approvedBySsh?.status !== "approved") {
          logGateway.info(
            `node pairing ssh-verify approval skipped device=${device.id} (request superseded or already resolved)`,
          );
          return;
        }
        logGateway.info(
          `security audit: device pairing ssh-verified auto-approve device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} sshUser=${outcome.user} client=${connectParams.client.id} conn=${connId}`,
        );
        buildRequestContext().broadcast(
          "device.pair.resolved",
          {
            requestId: pendingRequestId,
            deviceId: device.id,
            decision: "approved",
            ts: Date.now(),
          },
          { dropIfSlow: true },
        );
      },
      (error) => {
        logGateway.warn(`node pairing ssh-verify failed device=${device.id}: ${String(error)}`);
      },
    );
  }
  return Boolean(sshVerifyPlan && sshVerify);
}
