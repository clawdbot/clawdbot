import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateHoldResult, UpdateScheduleState } from "../api/types.ts";
import { controlUiVersionDiffersFrom, reloadControlUiIfStale } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import {
  closeDevicePairSetup as closeDevicePairSetupState,
  createDevicePairSetupState,
  openDevicePairSetup as openDevicePairSetupState,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup as refreshDevicePairSetupState,
  setDevicePairSetupAccess as setPairAccess,
  type DevicePairSetup,
  type DevicePairSetupAccess,
} from "../lib/device-pair-setup.ts";
import {
  createDeviceAuthMigrationLoader,
  EMPTY_DEVICE_AUTH_MIGRATION,
} from "./device-auth-migration-loader.ts";
import {
  clearExecApprovalTimers,
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseApprovalRequestedEvent,
  parseExecApprovalResolved,
  resolveApprovalRequest,
  type ExecApprovalDecision,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import {
  createOverlayApprovalRefresher,
  createOverlayPairingPendingCount,
  readOverlayOperatorAccessTransition,
} from "./overlays-access.ts";
import {
  createPendingUpdateReconciliation,
  createUpdateCampaignStatusPoller,
  createUpdateStatusRefresher,
  createUpdateVerificationController,
  projectUpdateStatusResponse,
  readUpdateAvailable,
  readUpdateAvailableValue,
  readUpdateSchedule,
  readUpdateScheduleValue,
  resolveExpectedUpdateSha,
  resolveUnknownUpdateOutcomeBanner,
  resolveUpdateStatusBanner,
  UPDATE_HANDOFF_STARTED_REASON,
  type ApplicationStatusBanner,
  type PendingUpdateReconciliation,
  type UpdateRestartStatusResponse,
  type UpdateRunResponse,
} from "./update-overlay-helpers.ts";

type ApplicationOverlaySnapshot = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateRunning: boolean;
  updateReconciliationPending: boolean;
  updateStatusBanner: ApplicationStatusBanner | null;
  controlUiRefreshRequired: boolean;
  approvalQueue: readonly ExecApprovalRequest[];
  approvalBusy: boolean;
  approvalErrors: ReadonlyMap<string, string>;
  approvalNowMs: number;
  devicePairSetupOpen: boolean;
  devicePairSetupLoading: boolean;
  devicePairSetupError: string | null;
  devicePairSetup: DevicePairSetup | null;
  devicePairSetupAccess: DevicePairSetupAccess;
  devicePairPendingCount: number;
  deviceAuthMigration: import("./device-auth-migration.ts").DeviceAuthMigrationSnapshot;
};

export type ApplicationOverlays = {
  readonly snapshot: ApplicationOverlaySnapshot;
  subscribe: (listener: (snapshot: ApplicationOverlaySnapshot) => void) => () => void;
  refreshUpdateStatus: () => Promise<void>;
  runUpdate: () => Promise<void>;
  holdUpdate: () => Promise<boolean>;
  decideApproval: (decision: ExecApprovalDecision, approvalId?: string) => Promise<void>;
  openDevicePairSetup: () => Promise<void>;
  refreshDevicePairSetup: () => Promise<void>;
  setDevicePairSetupAccess: (access: DevicePairSetupAccess) => Promise<void>;
  closeDevicePairSetup: () => void;
  secureThisBrowser: () => Promise<void>;
  dispose: () => void;
};

function isGatewayEvent(value: unknown): value is GatewayEventFrame {
  return Boolean(value && typeof value === "object" && "event" in value);
}

export function createApplicationOverlays(
  gateway: ApplicationGateway,
  hooks: {
    /** Barrier awaited after update-running is published and before update.run
     * is issued, so in-flight config writes cannot overlap the install. */
    drainConfigWrites?: () => Promise<void>;
  } = {},
): ApplicationOverlays {
  let snapshot: ApplicationOverlaySnapshot = {
    updateAvailable: null,
    updateSchedule: null,
    heldUpdateCampaignId: null,
    updateRunning: false,
    updateReconciliationPending: false,
    updateStatusBanner: null,
    controlUiRefreshRequired: false,
    approvalQueue: [],
    approvalBusy: false,
    approvalErrors: new Map(),
    approvalNowMs: Date.now(),
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    devicePairSetupAccess: "full",
    devicePairPendingCount: 0,
    deviceAuthMigration: EMPTY_DEVICE_AUTH_MIGRATION,
  };
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let activeHello = gateway.snapshot.hello;
  let connectedSource: NonNullable<typeof activeClient> | null = null; // Retries start a new source epoch.
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let approvalAccessGeneration = 0;
  let approvalGrantGeneration = 0;
  let pendingUpdate: PendingUpdateReconciliation | null = null;
  let updateRunGeneration = 0;
  let updateHoldInFlight = false;
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
  });
  const promptState: ExecApprovalPromptState = {
    client: activeClient,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalErrors: new Map(),
    execApprovalNowMs: Date.now(),
    execApprovalExpiryTimers: new Map(),
  };

  const publish = () => {
    snapshot = {
      ...snapshot,
      // The update RPC can finish before its restart handoff. Keep consumers
      // locked until the replacement Gateway reports the authoritative result.
      updateReconciliationPending: pendingUpdate !== null,
      approvalQueue: promptState.execApprovalQueue,
      approvalBusy: promptState.execApprovalBusy,
      approvalErrors: new Map(promptState.execApprovalErrors),
      approvalNowMs: promptState.execApprovalNowMs ?? Date.now(),
      ...readDevicePairSetupSnapshot(devicePairSetupState),
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
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
      publish();
    }
  };
  const isCurrentClient = (client: NonNullable<typeof activeClient>) =>
    !disposed &&
    activeClient === client &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected";

  const isCurrentDeviceAuthMigration = (client: NonNullable<typeof activeClient>, epoch: number) =>
    epoch === connectedEpoch &&
    isCurrentClient(client) &&
    gateway.snapshot.hello?.deviceAuthMigration?.pending === true;
  const deviceAuthMigration = createDeviceAuthMigrationLoader({
    gateway,
    isCurrent: isCurrentDeviceAuthMigration,
    onChange: (next) => {
      snapshot = { ...snapshot, deviceAuthMigration: next };
      publish();
    },
  });

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

  const publishUpdateBanner = (updateStatusBanner: ApplicationStatusBanner | null) => {
    snapshot = { ...snapshot, updateStatusBanner };
    publish();
  };
  const heldCampaignId = (schedule: UpdateScheduleState | null) =>
    schedule?.campaign?.holdUntilMs !== undefined
      ? schedule.campaign.id
      : snapshot.heldUpdateCampaignId;
  const updateVerification = createUpdateVerificationController({
    getPending: () => pendingUpdate,
    clearPending: () => {
      pendingUpdate = null;
    },
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    getHello: () => gateway.snapshot.hello,
    publish,
    publishBanner: publishUpdateBanner,
    onVerifiedInstall: reloadControlUiIfStale,
  });
  const applyUpdateStatusResponse = (response: UpdateRestartStatusResponse) => {
    snapshot = {
      ...snapshot,
      ...projectUpdateStatusResponse(response, {
        updateStatusBanner: snapshot.updateStatusBanner,
        heldUpdateCampaignId: snapshot.heldUpdateCampaignId,
      }),
    };
    publish();
  };
  const updateCampaignPoller = createUpdateCampaignStatusPoller({
    getClient: () => activeClient,
    getEpoch: () => connectedEpoch,
    canPoll: () => operatorAccess.canAdmin,
    getSchedule: () => snapshot.updateSchedule,
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    onStatus: applyUpdateStatusResponse,
  });
  const refreshUpdateStatus = createUpdateStatusRefresher({
    getClient: () => activeClient,
    getEpoch: () => connectedEpoch,
    canRefresh: () => operatorAccess.canAdmin,
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    onStatus: applyUpdateStatusResponse,
  });

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const previousClient = activeClient;
    const helloChanged = activeHello !== next.hello;
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
      approvalDecision = null;
      promptState.execApprovalBusy = false;
    }
    if (accessTransition.adminRevoked || accessTransition.pairingSetupRevoked) {
      // Admin revocation invalidates bearer setup codes; losing both setup
      // authorities must also close a pairing-only operator's retained modal.
      closeDevicePairSetupState(devicePairSetupState);
      pairingPendingCount.invalidate({ clear: true });
      if (accessTransition.adminRevoked) {
        updateRunGeneration += 1;
        updateVerification.cancel();
        const updateStatusBanner = pendingUpdate
          ? resolveUnknownUpdateOutcomeBanner()
          : snapshot.updateStatusBanner;
        pendingUpdate = null;
        snapshot = { ...snapshot, updateRunning: false, updateStatusBanner };
      }
    }
    if (accessTransition.pairingChanged) {
      pairingPendingCount.invalidate({
        clear: !operatorAccess.canAdmin && !operatorAccess.canPair,
      });
    }
    activeClient = next.client;
    activeHello = next.hello;
    connectedSource = nextConnectedSource;
    promptState.client = next.client;
    devicePairSetupState.client = next.client;
    devicePairSetupState.connected = connected;
    if (connectedSourceChanged) {
      updateRunGeneration += 1;
      updateVerification.cancel();
    }
    if (previousClient !== next.client || !connected) {
      approvalDecision = null;
      pairingPendingCount.invalidate({ clear: true });
      deviceAuthMigration.reset();
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
      snapshot = {
        ...snapshot,
        updateAvailable: null,
        updateSchedule: null,
        updateRunning: false,
      };
      updateCampaignPoller.stop();
      if (!next.client) {
        connectedEpoch = 0;
        snapshot = { ...snapshot, controlUiRefreshRequired: false };
      }
      clearExecApprovalTimers(promptState);
      publish();
      return;
    }
    const updateSchedule =
      connectedSourceChanged || helloChanged ? readUpdateSchedule(next.hello) : undefined;
    snapshot = {
      ...snapshot,
      ...(connectedSourceChanged || helloChanged
        ? {
            updateAvailable: readUpdateAvailable(next.hello),
            updateSchedule: updateSchedule ?? null,
            heldUpdateCampaignId: heldCampaignId(updateSchedule ?? null),
          }
        : {}),
      controlUiRefreshRequired: connectedSourceChanged
        ? connectedEpoch > 0 && controlUiVersionDiffersFrom(next.hello?.server?.version)
        : snapshot.controlUiRefreshRequired,
    };
    publish();
    updateCampaignPoller.sync();
    if (
      accessTransition.pairingChanged &&
      devicePairSetupState.devicePairSetupOpen &&
      (operatorAccess.canAdmin || operatorAccess.canPair)
    ) {
      void pairingPendingCount.refresh();
    }
    if (connectedSourceChanged) {
      connectedEpoch += 1;
      if (operatorAccess.canReviewApprovals) {
        void refreshApprovals(next.client, connectedEpoch, approvalAccessGeneration);
      }
      void deviceAuthMigration.refresh(next.client, connectedEpoch);
      void updateVerification.verify(next.client, connectedEpoch);
    } else if (accessTransition.reviewChanged && operatorAccess.canReviewApprovals) {
      void refreshApprovals(next.client, connectedEpoch, approvalAccessGeneration);
    }
  };
  const stopGateway = gateway.subscribe(synchronizeGateway);

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || !isGatewayEvent(event)) {
      return;
    }
    if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
      void pairingPendingCount.refresh();
      if (activeClient) {
        void deviceAuthMigration.refresh(activeClient, connectedEpoch);
      }
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
      const payload = event.payload as GatewayUpdateAvailableEventPayload | undefined;
      const updateSchedule =
        payload && Object.hasOwn(payload, "schedule")
          ? readUpdateScheduleValue(payload.schedule)
          : undefined;
      snapshot = {
        ...snapshot,
        updateAvailable: readUpdateAvailableValue(payload?.updateAvailable),
        ...(updateSchedule !== undefined
          ? {
              updateSchedule,
              heldUpdateCampaignId: heldCampaignId(updateSchedule),
            }
          : {}),
      };
      publish();
      updateCampaignPoller.sync();
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
    if (
      event.event === "exec.approval.resolved" ||
      event.event === "plugin.approval.resolved" ||
      event.event === "openclaw.approval.resolved"
    ) {
      const resolved = parseExecApprovalResolved(event.payload);
      if (resolved) {
        clearResolvedExecApprovalPrompt(promptState, resolved.id);
        publish();
      }
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
    refreshUpdateStatus,
    async runUpdate() {
      const client = gateway.snapshot.client;
      if (
        !client ||
        gateway.snapshot.phase !== "connected" ||
        disposed ||
        snapshot.updateRunning ||
        pendingUpdate !== null ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
      ) {
        return;
      }
      const generation = ++updateRunGeneration;
      snapshot = { ...snapshot, updateRunning: true, updateStatusBanner: null };
      publish();
      try {
        // updateRunning above suspends NEW config writes (bootstrap syncs it
        // into the runtime-config capability); this barrier drains writes
        // already in flight so none can commit or restart mid-install.
        await hooks.drainConfigWrites?.();
        if (
          disposed ||
          generation !== updateRunGeneration ||
          !readGatewayOperatorAccess(gateway.snapshot).canAdmin
        ) {
          return;
        }
        pendingUpdate = createPendingUpdateReconciliation(
          "ambiguous",
          snapshot.updateAvailable?.latestVersion?.trim() || null,
          resolveExpectedUpdateSha(snapshot.updateSchedule, snapshot.updateAvailable),
        );
        publish();
        const response = await client.request<UpdateRunResponse>("update.run", {});
        if (
          disposed ||
          generation !== updateRunGeneration ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        const status = response.result?.status ?? (response.ok === true ? "ok" : "error");
        const expectedVersion =
          response.result?.after?.version?.trim() || pendingUpdate.expectedVersion;
        const expectedSha = response.result?.after?.sha?.trim() || pendingUpdate.expectedSha;
        if (
          response.ok === true &&
          status === "skipped" &&
          response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
          response.handoff?.status === "started"
        ) {
          pendingUpdate = { expectedVersion, expectedSha, kind: "handoff" };
          return;
        }
        if (response.ok === true && status === "ok") {
          pendingUpdate = { expectedVersion, expectedSha, kind: "restart" };
          if (response.restart?.coalesced === true) {
            snapshot = {
              ...snapshot,
              updateStatusBanner: {
                tone: "info",
                text: t("updates.coalescedRestart"),
              },
            };
          }
          return;
        }
        pendingUpdate = null;
        if (response.ok !== true || status !== "ok") {
          snapshot = {
            ...snapshot,
            updateStatusBanner: resolveUpdateStatusBanner({
              status,
              reason: response.result?.reason,
            }),
          };
        }
      } catch (error) {
        if (
          disposed ||
          generation !== updateRunGeneration ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        pendingUpdate = null;
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: t("updates.error", {
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        };
      } finally {
        if (
          !disposed &&
          generation === updateRunGeneration &&
          activeClient === client &&
          gateway.snapshot.client === client
        ) {
          snapshot = { ...snapshot, updateRunning: false };
          publish();
        }
      }
    },
    async holdUpdate() {
      const client = gateway.snapshot.client;
      const campaign = snapshot.updateSchedule?.campaign;
      const busy = updateHoldInFlight || snapshot.updateRunning || pendingUpdate !== null;
      if (
        !client ||
        gateway.snapshot.phase !== "connected" ||
        disposed ||
        busy ||
        !campaign ||
        campaign.state === "applying" ||
        snapshot.heldUpdateCampaignId === campaign.id ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
      ) {
        return false;
      }
      updateHoldInFlight = true;
      try {
        const response = await client.request<UpdateHoldResult>("update.hold", {});
        if (disposed || gateway.snapshot.client !== client) {
          return false;
        }
        const updateSchedule = response.schedule && readUpdateScheduleValue(response.schedule);
        if (updateSchedule !== undefined || response.ok) {
          snapshot = {
            ...snapshot,
            ...(updateSchedule !== undefined ? { updateSchedule } : {}),
            heldUpdateCampaignId: response.ok
              ? campaign.id
              : heldCampaignId(updateSchedule ?? null),
          };
          publish();
        }
        return response.ok;
      } catch (error) {
        if (!disposed && gateway.snapshot.client === client) {
          const message = error instanceof Error ? error.message : String(error);
          publishUpdateBanner({ tone: "danger", text: t("updates.error", { error: message }) });
        }
        return false;
      } finally {
        updateHoldInFlight = false;
      }
    },
    async decideApproval(decision, approvalId) {
      const active = approvalId
        ? promptState.execApprovalQueue.find((entry) => entry.id === approvalId)
        : promptState.execApprovalQueue[0];
      const client = gateway.snapshot.client;
      if (
        !active ||
        !client ||
        promptState.execApprovalBusy ||
        disposed ||
        gateway.snapshot.phase !== "connected" ||
        !readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals
      ) {
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
          promptState.execApprovalQueue.some((entry) => entry.id === active.id)
        ) {
          promptState.execApprovalErrors.set(
            active.id,
            `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
        return;
      }
      devicePairSetupState.pendingCount = 0;
      const setupOperation = openDevicePairSetupState(devicePairSetupState);
      // Pairing-list latency must not keep a ready setup code behind the loading state.
      void pairingPendingCount.refresh();
      await publishDevicePairSetupOperation(setupOperation);
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
    async secureThisBrowser() {
      const client = activeClient;
      const epoch = connectedEpoch;
      await deviceAuthMigration.secure(client, epoch);
    },
    dispose() {
      disposed = true;
      approvalDecision = null;
      updateRunGeneration += 1;
      pairingPendingCount.invalidate();
      deviceAuthMigration.dispose();
      updateVerification.cancel();
      updateCampaignPoller.stop();
      closeDevicePairSetupState(devicePairSetupState);
      stopGateway();
      stopEvents();
      clearExecApprovalTimers(promptState);
      promptState.execApprovalErrors.clear();
      listeners.clear();
    },
  };
}
