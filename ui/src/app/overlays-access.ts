import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { createDevicePairSetupState } from "../lib/device-pair-setup.ts";
import { refreshPendingApprovalQueue, type ExecApprovalPromptState } from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

type OverlayOperatorAccess = ReturnType<typeof readGatewayOperatorAccess>;
type DevicePairSetupState = ReturnType<typeof createDevicePairSetupState>;

function canAccessDevicePairing(snapshot: ApplicationGateway["snapshot"]): boolean {
  const access = readGatewayOperatorAccess(snapshot);
  return access.canAdmin || access.canPair;
}

export function readOverlayOperatorAccessTransition(
  previous: OverlayOperatorAccess,
  snapshot: ApplicationGateway["snapshot"],
) {
  const access = readGatewayOperatorAccess(snapshot);
  return {
    access,
    reviewChanged: previous.canReviewApprovals !== access.canReviewApprovals,
    grantChanged: previous.canGrantApprovals !== access.canGrantApprovals,
    grantRevoked: previous.canGrantApprovals && !access.canGrantApprovals,
    adminRevoked: previous.canAdmin && !access.canAdmin,
    pairingChanged: previous.canPair !== access.canPair,
    pairingSetupRevoked:
      (previous.canAdmin || previous.canPair) && !(access.canAdmin || access.canPair),
  };
}

export function createOverlayPairingPendingCount(params: {
  gateway: ApplicationGateway;
  state: DevicePairSetupState;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  let generation = 0;

  return {
    invalidate(options: { clear?: boolean } = {}) {
      generation += 1;
      if (options.clear) {
        params.state.pendingCount = 0;
      }
    },

    async refresh() {
      const client = params.gateway.snapshot.client;
      if (
        !client ||
        params.gateway.snapshot.phase !== "connected" ||
        params.isDisposed() ||
        !params.state.devicePairSetupOpen ||
        !canAccessDevicePairing(params.gateway.snapshot)
      ) {
        return;
      }
      const requestGeneration = ++generation;
      let result: { pending?: unknown };
      try {
        result = await client.request<{ pending?: unknown }>("device.pair.list", {});
      } catch {
        return;
      }
      if (
        params.isDisposed() ||
        requestGeneration !== generation ||
        params.gateway.snapshot.client !== client ||
        params.gateway.snapshot.phase !== "connected" ||
        !params.state.devicePairSetupOpen ||
        !canAccessDevicePairing(params.gateway.snapshot)
      ) {
        return;
      }
      params.state.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
      params.publish();
    },
  };
}

export function createOverlayApprovalRefresher(params: {
  gateway: ApplicationGateway;
  state: ExecApprovalPromptState;
  getConnectedEpoch: () => number;
  getReviewGeneration: () => number;
  canReview: () => boolean;
  isCurrentClient: (client: GatewayBrowserClient) => boolean;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  return async (
    client: GatewayBrowserClient,
    epoch = params.getConnectedEpoch(),
    reviewGeneration = params.getReviewGeneration(),
  ) => {
    if (
      !params.canReview() ||
      reviewGeneration !== params.getReviewGeneration() ||
      !readGatewayOperatorAccess(params.gateway.snapshot).canReviewApprovals
    ) {
      return;
    }
    const applied = await refreshPendingApprovalQueue(params.state, {
      isCurrentClient: (requestClient) =>
        requestClient === client &&
        epoch === params.getConnectedEpoch() &&
        reviewGeneration === params.getReviewGeneration() &&
        params.canReview() &&
        readGatewayOperatorAccess(params.gateway.snapshot).canReviewApprovals &&
        params.isCurrentClient(client),
    });
    if (applied && !params.isDisposed()) {
      params.publish();
    }
  };
}
