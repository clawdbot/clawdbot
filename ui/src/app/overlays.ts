import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { UpdateHoldResult } from "../api/types.ts";
import { controlUiBuildDiffersFrom } from "../build-info.ts";
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
  classifyUpdateRunResponse,
  createUpdateCampaignStatusPoller,
  createUpdateStatusRefresher,
  createUpdateVerificationController,
  projectUpdateStatusResponse,
  resolveExpectedUpdateSha,
  resolveUnknownUpdateOutcomeBanner,
  resolveUpdateStatusBanner,
  UPDATE_HANDOFF_TIMEOUT_MS,
  type ApplicationStatusBanner,
  type PendingUpdateReconciliation,
  type UpdateRestartStatusResponse,
  type UpdateRunResponse,
} from "./update-overlay-helpers.ts";
import { readUpdateScheduleValue } from "./update-schedule-dto.ts";
import {
  projectConnectedUpdateSnapshot,
  projectUpdateAvailableEvent,
  resolveHeldUpdateCampaignId,
} from "./update-schedule-projection.ts";
import {
  announceRecordedUpdateSuccess,
  announceVerifiedUpdateInstall,
  readUpdateNotice,
  writeUpdateNotice,
} from "./update-success-notice.ts";

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
    updateStatusRefreshing: false,
    updateCampaignStatusHydrated: true,
    updateReconciliationPending: false,
    updateStatusBanner: null,
    recordedUpdateAttempt: null,
    controlUiRefreshRequired: false,
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
  let activeHello = gateway.snapshot.hello;
  let connectedSource: NonNullable<typeof activeClient> | null = null; // Retries start a new source epoch.
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let approvalAccessGeneration = 0;
  let approvalGrantGeneration = 0;
  let updateGatewayScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
  const savedUpdate = readUpdateNotice(updateGatewayScope);
  let pendingUpdate: PendingUpdateReconciliation | null =
    savedUpdate && savedUpdate.kind !== "verified" ? savedUpdate : null;
  let pendingUpdateProfileId = savedUpdate?.profileId ?? null;
  let pendingUpdateTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let updateRequestRunning = false;
  let updateStatusRevision = 0;
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
      updateRunning:
        updateRequestRunning || snapshot.updateSchedule?.campaign?.state === "applying",
      // The update RPC can finish before its restart handoff. Keep consumers
      // locked until the replacement Gateway reports the authoritative result.
      updateReconciliationPending: pendingUpdate !== null,
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

  const publishUpdateBanner = (updateStatusBanner: ApplicationStatusBanner | null) => {
    snapshot = { ...snapshot, updateStatusBanner };
    publish();
  };
  const publishRecordedUpdateAttempt = (
    recordedUpdateAttempt: ApplicationOverlaySnapshot["recordedUpdateAttempt"],
  ) => {
    snapshot = { ...snapshot, recordedUpdateAttempt };
    publish();
  };
  const noticeScope = () => ({
    gateway: updateGatewayScope,
    profileId: gateway.snapshot.selfUser?.id ?? null,
  });
  const clearPendingUpdateTimer = () => {
    if (pendingUpdateTimer !== null) {
      globalThis.clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = null;
    }
  };
  const setPendingUpdate = (pending: PendingUpdateReconciliation | null) => {
    pendingUpdate = pending;
    clearPendingUpdateTimer();
    writeUpdateNotice(
      pending
        ? { ...pending, gateway: updateGatewayScope, profileId: pendingUpdateProfileId }
        : null,
    );
    if (pending) {
      // This budget belongs to admission, not reconnect. A failed-closed
      // Gateway may never return to run the verification loop below.
      pendingUpdateTimer = globalThis.setTimeout(
        () => {
          if (disposed || pendingUpdate !== pending) {
            return;
          }
          updateRunGeneration += 1;
          updateVerification.cancel();
          updateRequestRunning = false;
          setPendingUpdate(null);
          publishUpdateBanner(resolveUnknownUpdateOutcomeBanner());
        },
        Math.max(0, pending.deadlineAtMs - Date.now()),
      );
    }
  };
  const updateVerification = createUpdateVerificationController({
    getPending: () => pendingUpdate,
    clearPending: () => {
      setPendingUpdate(null);
    },
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    getHello: () => gateway.snapshot.hello,
    publish,
    publishBanner: publishUpdateBanner,
    publishRecordedAttempt: publishRecordedUpdateAttempt,
    publishRecordedFailure: ({ attempt, banner }) => {
      // Both facts terminate the same reconciliation. Publishing either first
      // exposes a false success or a failure without its recorded cause.
      snapshot = { ...snapshot, recordedUpdateAttempt: attempt, updateStatusBanner: banner };
      publish();
    },
    onVerifiedInstall: (identity) => announceVerifiedUpdateInstall(identity, noticeScope()),
  });
  const applyUpdateStatusResponse = (response: UpdateRestartStatusResponse) => {
    // The admitted attempt has its own identity-aware verifier. A page refresh
    // must not race it with an unrelated retained sentinel.
    if (pendingUpdate) {
      return;
    }
    snapshot = {
      ...snapshot,
      ...projectUpdateStatusResponse(response, {
        updateStatusBanner: snapshot.updateStatusBanner,
        recordedUpdateAttempt: snapshot.recordedUpdateAttempt,
        heldUpdateCampaignId: snapshot.heldUpdateCampaignId,
      }),
      updateCampaignStatusHydrated: true,
    };
    publish();
  };
  const refreshUpdateStatus = createUpdateStatusRefresher({
    getClient: () => activeClient,
    getEpoch: () => connectedEpoch,
    getRevision: () => updateStatusRevision,
    canRefresh: () => !disposed && operatorAccess.canAdmin,
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    onRefreshing: (updateStatusRefreshing) => {
      snapshot = { ...snapshot, updateStatusRefreshing };
      publish();
    },
    onStatus: applyUpdateStatusResponse,
    onError: (error) => {
      publishUpdateBanner({
        tone: "danger",
        text: t("updates.error", { error: formatUiError(error) }),
      });
    },
  });
  const updateCampaignPoller = createUpdateCampaignStatusPoller({
    canPoll: () =>
      Boolean(activeClient && isCurrentClient(activeClient) && snapshot.updateSchedule?.campaign) &&
      operatorAccess.canAdmin,
    refresh: () => refreshUpdateStatus("background"),
  });

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const nextGatewayScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    if (nextGatewayScope !== updateGatewayScope) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
      setPendingUpdate(null);
      updateRequestRunning = false;
      updateGatewayScope = nextGatewayScope;
      snapshot = {
        ...snapshot,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        heldUpdateCampaignId: null,
      };
    }
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
      if (accessTransition.adminRevoked) {
        updateRunGeneration += 1;
        updateStatusRevision += 1;
        updateVerification.cancel();
        const updateStatusBanner = pendingUpdate ? resolveUnknownUpdateOutcomeBanner() : null;
        setPendingUpdate(null);
        updateRequestRunning = false;
        snapshot = {
          ...snapshot,
          updateStatusRefreshing: false,
          updateStatusBanner,
          recordedUpdateAttempt: null,
        };
      }
    }
    if (accessTransition.pairingChanged) {
      pairingPendingCount.invalidate({
        clear: !(operatorAccess.canAdmin || operatorAccess.canPair),
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
      updateStatusRevision += 1;
      updateVerification.cancel();
    }
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
      updateRequestRunning = false;
      promptState.execApprovalQueue = [];
      promptState.execApprovalBusy = false;
      promptState.execApprovalErrors.clear();
      snapshot = {
        ...snapshot,
        updateAvailable: null,
        updateSchedule: null,
        updateStatusRefreshing: false,
        updateCampaignStatusHydrated: true,
      };
      updateCampaignPoller.stop();
      if (next.phase === "reload-required") {
        snapshot = { ...snapshot, controlUiRefreshRequired: true };
      } else if (!next.client) {
        connectedEpoch = 0;
        snapshot = { ...snapshot, controlUiRefreshRequired: false };
      } else if (next.hello) {
        snapshot = { ...snapshot, controlUiRefreshRequired: true };
      }
      clearExecApprovalTimers(promptState);
      publish();
      return;
    }
    if (
      pendingUpdate &&
      (!operatorAccess.canAdmin || pendingUpdateProfileId !== (next.selfUser?.id ?? null))
    ) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
      setPendingUpdate(null);
      snapshot = { ...snapshot, updateStatusBanner: resolveUnknownUpdateOutcomeBanner() };
    }
    const serverBuildIdentity = {
      version: next.hello?.server?.version,
      buildId: next.hello?.server?.buildId,
      controlUiBuildSource: next.hello?.server?.controlUiBuildSource,
    };
    const exactBuildIdentityAvailable = Boolean(serverBuildIdentity.buildId?.trim());
    snapshot = {
      ...snapshot,
      ...(connectedSourceChanged || helloChanged
        ? projectConnectedUpdateSnapshot(snapshot, next.hello)
        : {}),
      controlUiRefreshRequired: connectedSourceChanged
        ? (exactBuildIdentityAvailable || connectedEpoch > 0) &&
          controlUiBuildDiffersFrom(serverBuildIdentity)
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
      announceRecordedUpdateSuccess(operatorAccess.canAdmin ? noticeScope() : null);
      if (operatorAccess.canReviewApprovals) {
        void refreshApprovals(next.client, connectedEpoch, approvalAccessGeneration);
      }
      if (pendingUpdate && operatorAccess.canAdmin) {
        void updateVerification.verify(next.client, connectedEpoch);
      } else if (operatorAccess.canAdmin && !snapshot.updateSchedule?.campaign) {
        // A new bundle has no in-memory campaign history. Hydrate the Gateway's
        // retained result so an automatic update failure survives that reload.
        void refreshUpdateStatus("background");
      }
    } else if (accessTransition.reviewChanged && operatorAccess.canReviewApprovals) {
      void refreshApprovals(next.client, connectedEpoch, approvalAccessGeneration);
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
      const payload = event.payload as GatewayUpdateAvailableEventPayload | undefined;
      const previousCampaign = snapshot.updateSchedule?.campaign;
      updateStatusRevision += 1;
      snapshot = {
        ...snapshot,
        ...projectUpdateAvailableEvent(snapshot, payload),
      };
      publish();
      updateCampaignPoller.sync();
      if (
        previousCampaign?.state === "applying" &&
        snapshot.updateSchedule?.campaign?.state !== "applying" &&
        activeClient &&
        operatorAccess.canAdmin
      ) {
        // Completion can arrive between polls. The producer records its outcome
        // before removing the campaign, so removal still needs one final read.
        if (pendingUpdate) {
          void updateVerification.verify(activeClient, connectedEpoch);
        } else {
          void refreshUpdateStatus("completion");
        }
      }
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
  if (pendingUpdate) {
    setPendingUpdate(pendingUpdate);
  }
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
      updateStatusRevision += 1;
      updateRequestRunning = true;
      snapshot = {
        ...snapshot,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
      };
      publish();
      let admittedPending: PendingUpdateReconciliation | null = null;
      try {
        // updateRunning above suspends NEW config writes (bootstrap syncs it
        // into the runtime-config capability); this barrier drains writes
        // already in flight so none can commit or restart mid-install.
        await hooks.drainConfigWrites?.();
        if (
          disposed ||
          generation !== updateRunGeneration ||
          snapshot.updateSchedule?.campaign?.state === "applying" ||
          !readGatewayOperatorAccess(gateway.snapshot).canAdmin
        ) {
          return;
        }
        pendingUpdateProfileId = gateway.snapshot.selfUser?.id ?? null;
        admittedPending = {
          kind: "ambiguous",
          expectedVersion: snapshot.updateAvailable?.latestVersion?.trim() || null,
          expectedSha: resolveExpectedUpdateSha(snapshot.updateSchedule, snapshot.updateAvailable),
          handoffId: null,
          deadlineAtMs: Date.now() + UPDATE_HANDOFF_TIMEOUT_MS,
        };
        setPendingUpdate(admittedPending);
        publish();
        const response = await client.request<UpdateRunResponse>("update.run", {});
        if (
          disposed ||
          generation !== updateRunGeneration ||
          pendingUpdate !== admittedPending ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        const accepted = classifyUpdateRunResponse(response, admittedPending);
        if (accepted) {
          setPendingUpdate(accepted.pending);
          if (accepted.banner) {
            snapshot = { ...snapshot, updateStatusBanner: accepted.banner };
          }
          return;
        }
        setPendingUpdate(null);
        snapshot = {
          ...snapshot,
          updateStatusBanner: resolveUpdateStatusBanner({
            status: response.result?.status ?? "error",
            reason: response.result?.reason,
          }),
        };
      } catch (error) {
        if (
          disposed ||
          generation !== updateRunGeneration ||
          pendingUpdate !== admittedPending ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        setPendingUpdate(null);
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: t("updates.error", {
              error: formatUiError(error),
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
          updateRequestRunning = false;
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
              : resolveHeldUpdateCampaignId(
                  updateSchedule ?? snapshot.updateSchedule,
                  snapshot.heldUpdateCampaignId,
                ),
          };
          publish();
        }
        return response.ok;
      } catch (error) {
        if (!disposed && gateway.snapshot.client === client) {
          const message = formatUiError(error);
          publishUpdateBanner({ tone: "danger", text: t("updates.error", { error: message }) });
        }
        return false;
      } finally {
        updateHoldInFlight = false;
      }
    },
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
      updateRunGeneration += 1;
      clearPendingUpdateTimer();
      pairingPendingCount.invalidate();
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
