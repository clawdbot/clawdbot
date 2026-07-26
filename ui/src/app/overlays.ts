import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";
import { controlUiVersionDiffersFrom } from "../build-info.ts";
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
  refreshPendingApprovalQueue,
  resolveApprovalRequest,
  type ExecApprovalDecision,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  isPendingUpdateHandoffSentinel,
  readUpdateAvailable,
  resolvePendingUpdateHandoffTimeoutBanner,
  resolvePostRestartUpdateBanner,
  resolveUpdateStatusBanner,
  resolveUpdateVerificationBanner,
  UPDATE_HANDOFF_POLL_MS,
  UPDATE_HANDOFF_STARTED_REASON,
  UPDATE_HANDOFF_TIMEOUT_MS,
  UPDATE_RESTART_VERIFICATION_POLL_MS,
  UPDATE_RESTART_VERIFICATION_TIMEOUT_MS,
  type ApplicationStatusBanner,
  type UpdateRestartStatusResponse,
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
  let pendingUpdateExpectedVersion: string | null = null;
  let pendingUpdateHandoff = false;
  let updateRunGeneration = 0;
  let updateVerificationGeneration = 0;
  let updateVerificationWait: UpdateVerificationWait | null = null;
  let devicePairPendingCountGeneration = 0;
  let approvalDecision: {
    client: NonNullable<typeof activeClient>;
    epoch: number;
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
      updateReconciliationPending: pendingUpdateHandoff || pendingUpdateExpectedVersion !== null,
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

  const refreshDevicePairPendingCount = async () => {
    const client = gateway.snapshot.client;
    if (
      !client ||
      gateway.snapshot.phase !== "connected" ||
      disposed ||
      !devicePairSetupState.devicePairSetupOpen
    ) {
      return;
    }
    const generation = ++devicePairPendingCountGeneration;
    let result: { pending?: unknown };
    try {
      result = await client.request<{ pending?: unknown }>("device.pair.list", {});
    } catch {
      return;
    }
    if (
      disposed ||
      generation !== devicePairPendingCountGeneration ||
      gateway.snapshot.client !== client ||
      gateway.snapshot.phase !== "connected" ||
      !devicePairSetupState.devicePairSetupOpen
    ) {
      return;
    }
    devicePairSetupState.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
    publish();
  };

  const refreshApprovals = async (
    client: NonNullable<typeof activeClient>,
    epoch = connectedEpoch,
  ) => {
    const applied = await refreshPendingApprovalQueue(promptState, {
      isCurrentClient: (requestClient) =>
        requestClient === client && epoch === connectedEpoch && isCurrentClient(client),
    });
    if (applied && !disposed) {
      publish();
    }
  };

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
    const expectedVersion = pendingUpdateExpectedVersion?.trim() || null;
    const pendingHandoff = pendingUpdateHandoff;
    if (!expectedVersion && !pendingHandoff) {
      return;
    }
    const isCurrentVerification = () =>
      generation === updateVerificationGeneration &&
      epoch === connectedEpoch &&
      !disposed &&
      activeClient === client &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    const deadline =
      Date.now() +
      (pendingHandoff ? UPDATE_HANDOFF_TIMEOUT_MS : UPDATE_RESTART_VERIFICATION_TIMEOUT_MS);
    const pollMs = pendingHandoff ? UPDATE_HANDOFF_POLL_MS : UPDATE_RESTART_VERIFICATION_POLL_MS;
    while (isCurrentVerification() && Date.now() < deadline) {
      let response: UpdateRestartStatusResponse | null;
      try {
        response = await client.request<UpdateRestartStatusResponse>("update.status", {});
      } catch {
        response = null;
      }
      if (!isCurrentVerification()) {
        return;
      }
      const sentinel = response?.sentinel;
      if (isPendingUpdateHandoffSentinel(sentinel)) {
        if (!(await waitForUpdateVerification(pollMs, generation))) {
          return;
        }
        continue;
      }
      if (sentinel?.kind === "update" && sentinel.status && sentinel.status !== "ok") {
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
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
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        publish();
        return;
      }
      if (sentinel?.kind === "update" && actualVersion) {
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        publishUpdateBanner(
          expectedVersion && actualVersion !== expectedVersion
            ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion })
            : null,
        );
        return;
      }
      if (!(await waitForUpdateVerification(pollMs, generation))) {
        return;
      }
    }
    if (!isCurrentVerification()) {
      return;
    }
    const currentVersion = gateway.snapshot.hello?.server?.version?.trim() || null;
    pendingUpdateExpectedVersion = null;
    pendingUpdateHandoff = false;
    publishUpdateBanner(
      expectedVersion && currentVersion !== expectedVersion
        ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion: currentVersion })
        : pendingHandoff
          ? resolvePendingUpdateHandoffTimeoutBanner()
          : null,
    );
  };

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const previousClient = activeClient;
    const connected = next.phase === "connected";
    const nextConnectedSource = connected ? next.client : null;
    const connectedSourceChanged = connectedSource !== nextConnectedSource;
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
      devicePairPendingCountGeneration += 1;
      deviceAuthMigration.reset();
      closeDevicePairSetupState(devicePairSetupState);
      devicePairSetupState.pendingCount = 0;
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
    if (connectedSourceChanged) {
      connectedEpoch += 1;
      void refreshApprovals(next.client, connectedEpoch);
      void deviceAuthMigration.refresh(next.client, connectedEpoch);
      void verifyPendingUpdateVersion(next.client, connectedEpoch);
    }
  };
  const stopGateway = gateway.subscribe(synchronizeGateway);

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || !isGatewayEvent(event)) {
      return;
    }
    if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
      void refreshDevicePairPendingCount();
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
      if (!client || gateway.snapshot.phase !== "connected" || disposed || snapshot.updateRunning) {
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
        if (disposed || generation !== updateRunGeneration) {
          return;
        }
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
        const expectedVersion = response.result?.after?.version?.trim() || null;
        if (
          response.ok === true &&
          status === "skipped" &&
          response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
          response.handoff?.status === "started"
        ) {
          pendingUpdateExpectedVersion = expectedVersion;
          pendingUpdateHandoff = true;
          return;
        }
        if (response.ok === true && status === "ok") {
          pendingUpdateExpectedVersion = expectedVersion;
          pendingUpdateHandoff = false;
          if (response.restart?.coalesced === true) {
            snapshot = {
              ...snapshot,
              updateStatusBanner: {
                tone: "info",
                text: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
              },
            };
          }
          return;
        }
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
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
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: `Update error: ${error instanceof Error ? error.message : String(error)}`,
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
      if (!active || !client || promptState.execApprovalBusy || disposed) {
        return;
      }
      promptState.execApprovalBusy = true;
      promptState.execApprovalErrors.delete(active.id);
      const operation = { client, epoch: connectedEpoch, id: active.id };
      approvalDecision = operation;
      const isCurrentOperation = () =>
        approvalDecision === operation &&
        operation.epoch === connectedEpoch &&
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
      if (disposed) {
        return;
      }
      devicePairSetupState.pendingCount = 0;
      const setupOperation = openDevicePairSetupState(devicePairSetupState);
      // Pairing-list latency must not keep a ready setup code behind the loading state.
      void refreshDevicePairPendingCount();
      await publishDevicePairSetupOperation(setupOperation);
    },
    async refreshDevicePairSetup() {
      if (disposed) {
        return;
      }
      await publishDevicePairSetupOperation(refreshDevicePairSetupState(devicePairSetupState));
    },
    async setDevicePairSetupAccess(access) {
      if (disposed) {
        return;
      }
      await publishDevicePairSetupOperation(setPairAccess(devicePairSetupState, access));
    },
    closeDevicePairSetup() {
      devicePairPendingCountGeneration += 1;
      closeDevicePairSetupState(devicePairSetupState);
      devicePairSetupState.pendingCount = 0;
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
      devicePairPendingCountGeneration += 1;
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
