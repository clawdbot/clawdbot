import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";
import { controlUiVersionDiffersFrom } from "../build-info.ts";
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
  isPendingUpdateHandoffSentinel,
  readUpdateAvailable,
  requestUpdateRestartStatus,
  resolveAmbiguousUpdateOutcomeBanner,
  resolvePendingUpdateHandoffTimeoutBanner,
  resolvePostRestartUpdateBanner,
  resolveUnknownUpdateOutcomeBanner,
  resolveUpdateStatusBanner,
  resolveUpdateVerificationWindow,
  resolveUpdateVerificationBanner,
  UPDATE_HANDOFF_STARTED_REASON,
  type ApplicationStatusBanner,
  type UpdateRunResponse,
} from "./update-overlay-helpers.ts";

type ApplicationOverlaySnapshot = {
  updateAvailable: UpdateAvailable | null;
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
  runUpdate: () => Promise<void>;
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

type UpdateVerificationWait = {
  timer: ReturnType<typeof globalThis.setTimeout>;
  resolve: (active: boolean) => void;
};

type PendingUpdate = { expected: string | null; kind: "ambiguous" | "handoff" | "restart" };

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
  let connectedSource: NonNullable<typeof activeClient> | null = null; // Retries start a new source epoch.
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let approvalAccessGeneration = 0;
  let approvalGrantGeneration = 0;
  let pendingUpdate: PendingUpdate | null = null;
  let updateRunGeneration = 0;
  let updateVerificationGeneration = 0;
  let updateVerificationWait: UpdateVerificationWait | null = null;
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

  const settleUpdateVerificationWait = (active: boolean) => {
    const wait = updateVerificationWait;
    if (!wait) {
      return;
    }
    updateVerificationWait = null;
    globalThis.clearTimeout(wait.timer);
    wait.resolve(active);
  };

  const cancelUpdateVerification = () => {
    updateVerificationGeneration += 1;
    settleUpdateVerificationWait(false);
  };

  const waitForUpdateVerification = (delayMs: number, generation: number) =>
    new Promise<boolean>((resolve) => {
      // Verification loops are serialized, but settling a prior wait keeps a
      // future refactor from stranding its continuation behind a replaced timer.
      settleUpdateVerificationWait(false);
      const timer = globalThis.setTimeout(() => {
        if (updateVerificationWait?.timer !== timer) {
          return;
        }
        updateVerificationWait = null;
        resolve(generation === updateVerificationGeneration && !disposed);
      }, delayMs);
      updateVerificationWait = { timer, resolve };
    });

  const verifyPendingUpdateVersion = async (
    client: NonNullable<typeof activeClient>,
    epoch: number,
  ) => {
    const generation = updateVerificationGeneration;
    const reconciliation = pendingUpdate;
    if (!reconciliation) {
      return;
    }
    const expectedVersion = reconciliation.expected?.trim() || null;
    if (reconciliation.kind === "ambiguous") {
      // Only the replacement Gateway version can prove a response-lost request; status is cached.
      pendingUpdate = null;
      publishUpdateBanner(
        resolveAmbiguousUpdateOutcomeBanner(expectedVersion, gateway.snapshot.hello),
      );
      return;
    }
    const isCurrentVerification = () =>
      generation === updateVerificationGeneration &&
      epoch === connectedEpoch &&
      !disposed &&
      activeClient === client &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    let { deadline, pollMs } = resolveUpdateVerificationWindow(reconciliation.kind);
    while (isCurrentVerification() && Date.now() < deadline) {
      const response = await requestUpdateRestartStatus(client, Math.max(0, deadline - Date.now()));
      if (!isCurrentVerification()) {
        return;
      }
      const sentinel = response?.sentinel;
      if (isPendingUpdateHandoffSentinel(sentinel)) {
        if (reconciliation.kind !== "handoff") {
          // Confirmed updates can become managed handoffs; preserve the longer lifecycle budget.
          reconciliation.kind = "handoff";
          ({ deadline, pollMs } = resolveUpdateVerificationWindow("handoff"));
          publish();
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        if (!(await waitForUpdateVerification(Math.min(pollMs, remainingMs), generation))) {
          return;
        }
        continue;
      }
      if (sentinel?.kind === "update" && sentinel.status && sentinel.status !== "ok") {
        pendingUpdate = null;
        publishUpdateBanner(resolvePostRestartUpdateBanner(sentinel.stats?.reason));
        return;
      }
      const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
      if (
        sentinel?.kind === "update" &&
        sentinel.status === "ok" &&
        !actualVersion &&
        !expectedVersion
      ) {
        pendingUpdate = null;
        publish();
        return;
      }
      if (sentinel?.kind === "update" && actualVersion) {
        pendingUpdate = null;
        publishUpdateBanner(
          expectedVersion && actualVersion !== expectedVersion
            ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion })
            : null,
        );
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      if (!(await waitForUpdateVerification(Math.min(pollMs, remainingMs), generation))) {
        return;
      }
    }
    if (!isCurrentVerification()) {
      return;
    }
    const currentVersion = gateway.snapshot.hello?.server?.version?.trim() || null;
    pendingUpdate = null;
    publishUpdateBanner(
      expectedVersion && currentVersion !== expectedVersion
        ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion: currentVersion })
        : reconciliation.kind === "handoff"
          ? resolvePendingUpdateHandoffTimeoutBanner()
          : null,
    );
  };

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
        cancelUpdateVerification();
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
    connectedSource = nextConnectedSource;
    promptState.client = next.client;
    devicePairSetupState.client = next.client;
    devicePairSetupState.connected = connected;
    if (connectedSourceChanged) {
      updateRunGeneration += 1;
      cancelUpdateVerification();
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
        updateRunning: false,
      };
      if (!next.client) {
        connectedEpoch = 0;
        snapshot = { ...snapshot, controlUiRefreshRequired: false };
      }
      clearExecApprovalTimers(promptState);
      publish();
      return;
    }
    snapshot = {
      ...snapshot,
      updateAvailable: readUpdateAvailable(next.hello),
      controlUiRefreshRequired: connectedSourceChanged
        ? connectedEpoch > 0 && controlUiVersionDiffersFrom(next.hello?.server?.version)
        : snapshot.controlUiRefreshRequired,
    };
    publish();
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
      void verifyPendingUpdateVersion(next.client, connectedEpoch);
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
      snapshot = { ...snapshot, updateAvailable: payload?.updateAvailable ?? null };
      publish();
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
        const announcedVersion = snapshot.updateAvailable?.latestVersion?.trim() || null;
        pendingUpdate = { expected: announcedVersion, kind: "ambiguous" };
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
        const expectedVersion = response.result?.after?.version?.trim() || announcedVersion;
        if (
          response.ok === true &&
          status === "skipped" &&
          response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
          response.handoff?.status === "started"
        ) {
          pendingUpdate = { expected: expectedVersion, kind: "handoff" };
          return;
        }
        if (response.ok === true && status === "ok") {
          pendingUpdate = { expected: expectedVersion, kind: "restart" };
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
      cancelUpdateVerification();
      closeDevicePairSetupState(devicePairSetupState);
      stopGateway();
      stopEvents();
      clearExecApprovalTimers(promptState);
      promptState.execApprovalErrors.clear();
      listeners.clear();
    },
  };
}
