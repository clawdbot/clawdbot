import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  closeDevicePairSetup as closeDevicePairSetupState,
  completeDevicePairSetup,
  createDevicePairSetupState,
  markDevicePairSetupDeliveryUncertain,
  openDevicePairSetup as openDevicePairSetupState,
  parseDevicePairSetupCompletion,
  parseDevicePairSetupDeliveryUncertain,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup as refreshDevicePairSetupState,
  setDevicePairSetupAccess as setPairAccess,
  syncDevicePairSetupCountdown,
} from "../lib/device-pair-setup.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import {
  clearExecApprovalTimers,
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseApprovalRequestedEvent,
  parseApprovalResolvedEvent,
  resolveApprovalRequest,
  type ExecApprovalPromptState,
} from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import {
  createOverlayApprovalRefresher,
  createOverlayPairingPendingCount,
  readOverlayOperatorAccessTransition,
} from "./overlays-access.ts";
import type { ApplicationOverlays, ApplicationOverlaySnapshot } from "./overlays-types.ts";
import {
  createApplicationUpdateOverlays,
  type ApplicationUpdateOverlayHooks,
} from "./overlays-updates.ts";

function isGatewayEvent(value: unknown): value is GatewayEventFrame {
  return Boolean(value && typeof value === "object" && "event" in value);
}

export function createApplicationOverlays(
  gateway: ApplicationGateway,
  hooks: ApplicationUpdateOverlayHooks & {
    connectionBootstrap?: ConnectionBootstrapCoordinator;
  } = {},
): ApplicationOverlays {
  const updates = createApplicationUpdateOverlays(gateway, publish, hooks);
  const runConnectionBootstrap = (key: string, task: () => Promise<unknown>) =>
    hooks.connectionBootstrap?.run(key, task) ?? task();
  let snapshot: ApplicationOverlaySnapshot = {
    ...updates.snapshot,
    approvalQueue: [],
    approvalBusy: false,
    approvalCanGrant: false,
    approvalErrors: new Map(),
    devicePairSetupOpen: false,
    devicePairSetupLifecycle: { phase: "selection", access: "full" },
    devicePairPendingCount: 0,
  };
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let connectedSource: NonNullable<typeof activeClient> | null = null; // Retries start a new source epoch.
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let approvalAccessGeneration = 0;
  let approvalGrantGeneration = 0;
  let approvalDecision: {
    client: NonNullable<typeof activeClient>;
    epoch: number;
    accessGeneration: number;
    grantGeneration: number;
    id: string;
  } | null = null;
  const devicePairSetupState = createDevicePairSetupState({
    client: gateway.snapshot.client,
    connected: gateway.snapshot.phase === "connected",
    onChange: () => publish(),
  });
  const promptState: ExecApprovalPromptState = {
    client: activeClient,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalErrors: new Map(),
    execApprovalExpiryTimers: new Map(),
  };

  function publish() {
    snapshot = {
      ...snapshot,
      ...updates.snapshot,
      approvalQueue: promptState.execApprovalQueue,
      approvalBusy: promptState.execApprovalBusy,
      approvalCanGrant: readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals,
      approvalErrors: new Map(promptState.execApprovalErrors),
      ...readDevicePairSetupSnapshot(devicePairSetupState),
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }
  promptState.execApprovalChanged = publish;
  const pairingPendingCount = createOverlayPairingPendingCount({
    gateway,
    state: devicePairSetupState,
    isDisposed: () => disposed,
    publish,
  });
  const publishDevicePairSetupOperation = async (operation: Promise<void>) => {
    publish();
    await operation;
    if (!disposed) {
      syncDevicePairSetupCountdown(devicePairSetupState, publish);
      publish();
    }
  };
  const isCurrentClient = (client: NonNullable<typeof activeClient>) =>
    !disposed &&
    activeClient === client &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected";

  const refreshApprovals = createOverlayApprovalRefresher({
    gateway,
    state: promptState,
    getConnectedEpoch: () => connectedEpoch,
    getReviewGeneration: () => approvalAccessGeneration,
    canReview: () => operatorAccess.canReviewApprovals,
    isCurrentClient,
    isDisposed: () => disposed,
    publish,
  });

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const previousClient = activeClient;
    const connected = next.phase === "connected";
    const nextConnectedSource = connected ? next.client : null;
    const connectedSourceChanged = connectedSource !== nextConnectedSource;
    const accessTransition = readOverlayOperatorAccessTransition(operatorAccess, next);
    operatorAccess = accessTransition.access;
    if (accessTransition.reviewChanged) {
      approvalAccessGeneration += 1;
    }
    if (accessTransition.grantChanged) {
      approvalGrantGeneration += 1;
    }
    if (accessTransition.grantRevoked) {
      // Review can remain available without a decision grant. Retire the
      // in-flight owner without discarding the still-readable approval queue.
      const revokedDecision = approvalDecision;
      if (
        revokedDecision &&
        promptState.execApprovalQueue.some((entry) => entry.id === revokedDecision.id)
      ) {
        promptState.execApprovalErrors.set(revokedDecision.id, t("execApproval.reviewOnly"));
      }
      approvalDecision = null;
      promptState.execApprovalBusy = false;
    }
    if (accessTransition.adminRevoked || accessTransition.pairingSetupRevoked) {
      // Admin revocation invalidates bearer setup codes; losing both setup
      // authorities must also close a pairing-only operator's retained modal.
      closeDevicePairSetupState(devicePairSetupState);
      pairingPendingCount.invalidate({ clear: true });
    }
    if (accessTransition.pairingChanged) {
      pairingPendingCount.invalidate({
        clear: !(operatorAccess.canAdmin || operatorAccess.canPair),
      });
    }
    activeClient = next.client;
    connectedSource = nextConnectedSource;
    promptState.client = next.client;
    devicePairSetupState.client = next.client;
    devicePairSetupState.connected = connected;
    if (previousClient !== next.client || !connected) {
      approvalDecision = null;
      pairingPendingCount.invalidate({ clear: true });
      closeDevicePairSetupState(devicePairSetupState);
    }
    if (connected && !operatorAccess.canReviewApprovals) {
      approvalDecision = null;
      promptState.execApprovalQueue = [];
      promptState.execApprovalBusy = false;
      promptState.execApprovalErrors.clear();
      clearExecApprovalTimers(promptState);
    }
    if (!connected || !next.client) {
      promptState.execApprovalQueue = [];
      promptState.execApprovalBusy = false;
      promptState.execApprovalErrors.clear();
      if (next.phase !== "reload-required" && !next.client) {
        connectedEpoch = 0;
      }
      clearExecApprovalTimers(promptState);
      updates.synchronizeGateway(next);
      return;
    }
    const connectedClient = next.client;
    updates.synchronizeGateway(next);
    if (
      accessTransition.pairingChanged &&
      devicePairSetupState.devicePairSetupOpen &&
      (operatorAccess.canAdmin || operatorAccess.canPair)
    ) {
      void runConnectionBootstrap("pairing-pending-count", () =>
        pairingPendingCount.refresh(),
      ).catch(() => undefined);
    }
    if (connectedSourceChanged) {
      connectedEpoch += 1;
      if (operatorAccess.canReviewApprovals) {
        void runConnectionBootstrap("approvals", () =>
          refreshApprovals(connectedClient, connectedEpoch, approvalAccessGeneration),
        ).catch(() => undefined);
      }
    } else if (accessTransition.reviewChanged && operatorAccess.canReviewApprovals) {
      void runConnectionBootstrap("approvals", () =>
        refreshApprovals(connectedClient, connectedEpoch, approvalAccessGeneration),
      ).catch(() => undefined);
    }
  };
  const stopGateway = gateway.subscribe(synchronizeGateway);

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || !isGatewayEvent(event)) {
      return;
    }
    if (event.event === "device.pair.setup.completed") {
      const completion = parseDevicePairSetupCompletion(event.payload);
      if (completion) {
        completeDevicePairSetup(devicePairSetupState, completion);
      }
      return;
    }
    if (event.event === "device.pair.setup.deliveryUncertain") {
      const outcome = parseDevicePairSetupDeliveryUncertain(event.payload);
      if (outcome) {
        markDevicePairSetupDeliveryUncertain(devicePairSetupState, outcome);
      }
      return;
    }
    if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
      void pairingPendingCount.refresh();
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
      updates.handleUpdateAvailable(
        event.payload as GatewayUpdateAvailableEventPayload | undefined,
      );
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_RUN_CHANGED) {
      updates.handleUpdateRunChanged(event.payload);
      return;
    }
    if (
      !operatorAccess.canReviewApprovals ||
      !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals
    ) {
      return;
    }
    const requestedApproval = parseApprovalRequestedEvent(event.event, event.payload);
    if (requestedApproval) {
      enqueueExecApprovalPrompt(promptState, requestedApproval);
      publish();
      return;
    }
    const resolvedApproval = parseApprovalResolvedEvent(event.event, event.payload);
    if (resolvedApproval) {
      clearResolvedExecApprovalPrompt(promptState, resolvedApproval.id);
      publish();
    }
  });
  synchronizeGateway(gateway.snapshot);

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshUpdateStatus: updates.refreshUpdateStatus,
    acknowledgeUpdateRun: updates.acknowledgeUpdateRun,
    runUpdate: updates.runUpdate,
    holdUpdate: updates.holdUpdate,
    async decideApproval(decision, approvalId, projectedApproval) {
      const active = approvalId
        ? (promptState.execApprovalQueue.find((entry) => entry.id === approvalId) ??
          (projectedApproval?.id === approvalId ? projectedApproval : undefined))
        : promptState.execApprovalQueue[0];
      const client = gateway.snapshot.client;
      if (!active || promptState.execApprovalBusy || disposed) {
        return;
      }
      const isProjectedApproval = active === projectedApproval;
      if (!client || gateway.snapshot.phase !== "connected") {
        promptState.execApprovalErrors.set(active.id, t("sessionsView.actionRequiresConnection"));
        publish();
        return;
      }
      if (!readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals) {
        promptState.execApprovalErrors.set(active.id, t("execApproval.reviewOnly"));
        publish();
        return;
      }
      promptState.execApprovalBusy = true;
      promptState.execApprovalErrors.delete(active.id);
      const operation = {
        client,
        epoch: connectedEpoch,
        accessGeneration: approvalAccessGeneration,
        grantGeneration: approvalGrantGeneration,
        id: active.id,
      };
      approvalDecision = operation;
      const isCurrentOperation = () =>
        approvalDecision === operation &&
        operation.epoch === connectedEpoch &&
        operation.accessGeneration === approvalAccessGeneration &&
        operation.grantGeneration === approvalGrantGeneration &&
        readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals &&
        isCurrentClient(operation.client);
      publish();
      try {
        await resolveApprovalRequest(client, active, decision);
        if (!isCurrentOperation()) {
          return;
        }
        clearResolvedExecApprovalPrompt(promptState, active.id);
      } catch (error) {
        if (isStaleApprovalResolutionError(error)) {
          if (!isCurrentOperation()) {
            return;
          }
          clearResolvedExecApprovalPrompt(promptState, active.id);
          const currentClient = activeClient;
          const epoch = connectedEpoch;
          if (currentClient && isCurrentOperation()) {
            await refreshApprovals(currentClient, epoch);
          }
          return;
        }
        if (
          isCurrentOperation() &&
          (isProjectedApproval ||
            promptState.execApprovalQueue.some((entry) => entry.id === active.id))
        ) {
          promptState.execApprovalErrors.set(active.id, `Approval failed: ${formatUiError(error)}`);
        }
      } finally {
        // Reconnect can admit a new decision while this request is still settling.
        // Only the operation that owns the busy state may release it.
        if (approvalDecision === operation) {
          approvalDecision = null;
          promptState.execApprovalBusy = false;
          publish();
        }
      }
    },
    async openDevicePairSetup() {
      const access = readGatewayOperatorAccess(gateway.snapshot);
      if (disposed || (!access.canAdmin && !access.canPair)) {
        return false;
      }
      devicePairSetupState.pendingCount = 0;
      const setupOperation = openDevicePairSetupState(devicePairSetupState);
      // Pairing-list latency must not keep a ready setup code behind the loading state.
      void pairingPendingCount.refresh();
      await publishDevicePairSetupOperation(setupOperation);
      return devicePairSetupState.devicePairSetupOpen;
    },
    async refreshDevicePairSetup() {
      if (disposed || !readGatewayOperatorAccess(gateway.snapshot).canAdmin) {
        return;
      }
      await publishDevicePairSetupOperation(refreshDevicePairSetupState(devicePairSetupState));
    },
    async setDevicePairSetupAccess(access) {
      if (disposed || !readGatewayOperatorAccess(gateway.snapshot).canAdmin) {
        return;
      }
      await publishDevicePairSetupOperation(setPairAccess(devicePairSetupState, access));
    },
    closeDevicePairSetup() {
      pairingPendingCount.invalidate({ clear: true });
      closeDevicePairSetupState(devicePairSetupState);
      publish();
    },
    dispose() {
      disposed = true;
      approvalDecision = null;
      updates.dispose();
      pairingPendingCount.invalidate();
      closeDevicePairSetupState(devicePairSetupState);
      stopGateway();
      stopEvents();
      clearExecApprovalTimers(promptState);
      promptState.execApprovalErrors.clear();
      listeners.clear();
    },
  };
}
