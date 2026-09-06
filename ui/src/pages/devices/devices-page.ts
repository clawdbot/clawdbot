import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED } from "../../../../src/gateway/events.js";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { showSecretRevealDialog } from "../../components/secret-reveal-dialog.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  approveDevicePairing,
  approveNodePairingRequest,
  createInitialDevicesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
  removeExecApprovalsFormValue,
  rotateDeviceToken,
  saveExecApprovals,
  updateExecApprovalsFormValue,
  type ExecApprovalsTarget,
  type DevicesPageDataState,
} from "../../lib/nodes/index.ts";
import { presenceConnectivitySignature } from "../../lib/nodes/inventory.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { DevicesDialogController } from "./devices-dialogs.ts";
import { renderDevices } from "./view.ts";

const DEVICES_DOCS_URL = "https://docs.openclaw.ai/nodes";

export type DevicesRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  devices: DevicesPageDataState;
};

const DEVICES_ACTIVE_POLL_INTERVAL_MS = 30_000;
const SYSTEM_INFO_POLL_INTERVAL_MS = 60_000;

class DevicesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: DevicesRouteData;

  @state() presence: PresenceEntry[] = [];
  @state() private gatewaySystemInfo: SystemInfoResult | null = null;
  @state() private desktopEnvironments: EnvironmentSummary[] = [];
  private systemInfoUnavailable = false;
  @state() private pageState = createInitialDevicesState();
  @state() private canPairDevice = false;
  @state() private canManagePairing = false;
  @state() private canAdmin = false;
  @state() private execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() private execApprovalsTargetNodeId: string | null = null;
  private pendingConfirmation: AbortController | null = null;
  // Dialog orchestration (destructive confirmations + the alias editor) lives
  // in its own controller; the page exposes only the narrow seam it needs.
  private readonly dialogs = new DevicesDialogController({
    canManagePairing: () => this.canManagePairing,
    gatewayConnected: () => this.gateway.connected,
    requestGeneration: () => this.requestGeneration,
    gatewayClient: () => this.gateway.client,
    gatewayUrl: () => this.context.gateway.connection.gatewayUrl,
    runPageTask: (task) => this.runPageTask(task),
    pendingDialog: () => this.pendingConfirmation,
    setPendingDialog: (controller) => {
      this.pendingConfirmation = controller;
    },
    setDevicesError: (message) => {
      this.pageState.devicesError = message;
      // The controller writes outside the page's task cycle; the callout must
      // render without waiting for the next unrelated update.
      this.requestUpdate();
    },
  });

  private routeDataInitialized = false;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: (change) => this.resetServerState(change.snapshot),
    invalidateRequests: (change) => {
      this.pageState.requestGeneration = this.gateway.epoch;
      if (!change.identityChanged && change.snapshot.phase !== "connected") {
        this.resetServerState(change.snapshot);
      }
      void this.presenceTask.run([null, null]);
    },
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
    ensureInitialData: () => this.ensureInitialData(),
  });
  private readonly presenceTask = new Task(this, {
    autoRun: false,
    // Gateway identity invalidates same-client reconnects and source replacements.
    args: () =>
      [
        this.gateway.connected ? this.gateway.gateway : null,
        this.gateway.connected ? this.gateway.client : null,
      ] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client ? client.request("system-presence", {}, { signal }) : initialState,
    onComplete: (response) => {
      if (Array.isArray(response)) {
        this.presence = response as PresenceEntry[];
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        this.presence = [];
      }
    },
  });
  private readonly systemInfoTask = new Task(this, {
    args: () =>
      [this.gateway.gateway, this.canLoadSystemInfo ? this.gateway.client : null] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client
        ? client.request<SystemInfoResult>("system.info", {}, { signal })
        : initialState,
    onComplete: (result) => {
      this.gatewaySystemInfo = result;
      // Quiet node reloads also fetch stats; a fresh snapshot restarts the periodic deadline.
      this.systemInfoPolling.stop();
      this.systemInfoPolling.start();
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        this.gatewaySystemInfo = null;
        this.systemInfoUnavailable = true;
        this.systemInfoPolling.stop();
      }
    },
  });
  private readonly environmentsTask = new Task(this, {
    args: () =>
      [this.gateway.gateway, this.canLoadDesktopEnvironments ? this.gateway.client : null] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client
        ? client.request<EnvironmentsListResult>("environments.list", {}, { signal })
        : initialState,
    onComplete: (result) => {
      this.desktopEnvironments = result.environments;
    },
    onError: () => {
      this.desktopEnvironments = [];
    },
  });
  private readonly systemInfoPolling = new PollController(
    this,
    SYSTEM_INFO_POLL_INTERVAL_MS,
    () => this.refreshSystemInfo(),
    false,
  );
  private readonly polling = new PollController(
    this,
    DEVICES_ACTIVE_POLL_INTERVAL_MS,
    () => {
      this.refreshNodeInventory(true);
      if (this.canManagePairing) {
        void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
      }
    },
    false,
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (this.gateway.gateway !== gateway || this.context.gateway !== gateway) {
            return;
          }
          const presence = event.event === "presence" ? readPresenceEntries(event.payload) : null;
          if (presence) {
            const connectivityChanged =
              presenceConnectivitySignature(presence) !==
              presenceConnectivitySignature(this.presence);
            void this.presenceTask.run([null, null]);
            this.presence = presence;
            if (connectivityChanged) {
              if (this.canManagePairing) {
                void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
              }
              this.refreshNodeInventory(true);
            }
          }
          if (
            event.event === GATEWAY_EVENT_DEVICE_PAIR_CHANGED ||
            event.event === "device.pair.requested" ||
            event.event === "device.pair.resolved"
          ) {
            if (this.canManagePairing) {
              void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
            }
          }
          if (
            event.event === "node.pair.requested" ||
            event.event === "node.pair.resolved" ||
            event.event === "node.runnerInventory.changed" ||
            event.event === "node.hostStats"
          ) {
            this.refreshNodeInventory(true);
          }
        }),
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.cancelPendingConfirmation();
    this.subscriptions.clear();
    void this.presenceTask.run([null, null]);
    this.resetInventoryDetails();
    this.presence = [];
    this.canPairDevice = false;
    this.canManagePairing = false;
    this.canAdmin = false;
    super.disconnectedCallback();
  }

  get requestGeneration(): number {
    return this.pageState.requestGeneration;
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    this.pageState.client = snapshot.client;
    this.pageState.connected = snapshot.phase === "connected";
    this.pageState.requestGeneration = this.gateway.epoch;
    this.syncGatewayState(snapshot);
    if (!this.canLoadSystemInfo) {
      void this.systemInfoTask.run([null, null]);
      this.gatewaySystemInfo = null;
    }
    if (!this.canLoadDesktopEnvironments) {
      void this.environmentsTask.run([null, null]);
      this.desktopEnvironments = [];
    }
    if (
      this.routeDataInitialized &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      (change.identityChanged || change.connectionChanged)
    ) {
      const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presence = initialPresence ?? [];
      void this.loadPresence();
    }
    this.syncPolling();
  }

  private syncGatewayState(snapshot: ApplicationGatewaySnapshot) {
    const connected = snapshot.phase === "connected";
    const auth = snapshot.hello?.auth ?? null;
    this.canAdmin = connected && hasOperatorAdminAccess(auth);
    this.canManagePairing = connected && (!auth || hasOperatorPairingAccess(auth));
    this.canPairDevice = this.canAdmin;
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    const snapshot = this.context.gateway.snapshot;
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.resetServerState(snapshot);
      this.presence = readPresenceEntries(snapshot.hello?.snapshot) ?? [];
      void this.loadPresence();
      this.ensureInitialData();
      return;
    }
    this.pageState = {
      ...data.devices,
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      requestGeneration: this.gateway.epoch,
    };
    const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
    if (initialPresence) {
      this.presence = initialPresence;
    }
    void this.loadPresence();
  }

  private resetServerState(snapshot: ApplicationGatewaySnapshot) {
    this.cancelPendingConfirmation();
    this.pageState.requestGeneration += 1;
    const next = createInitialDevicesState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
    next.requestGeneration = this.gateway.epoch;
    this.pageState = next;
    void this.presenceTask.run([null, null]);
    this.presence = [];
    this.resetInventoryDetails();
  }

  private async runPageTask<T>(
    task: (pageState: DevicesPageDataState) => T | Promise<T>,
  ): Promise<T> {
    const pageState = this.pageState;
    try {
      const result = task(pageState);
      if (this.pageState === pageState) {
        this.requestUpdate();
      }
      return await result;
    } finally {
      if (this.pageState === pageState) {
        this.requestUpdate();
      }
    }
  }

  private ensureInitialData() {
    const pageState = this.pageState;
    if (!pageState.connected || !pageState.client || !this.routeDataInitialized) {
      return;
    }
    if (!pageState.nodes.length && !pageState.nodesLoading) {
      this.refreshNodeInventory();
    }
    if (this.canManagePairing && !pageState.devicesList && !pageState.devicesLoading) {
      void this.runPageTask((current) => loadDevices(current));
    }
    const config = this.context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void this.context.runtimeConfig.refresh();
    }
    if (this.canAdmin && !pageState.execApprovalsSnapshot && !pageState.execApprovalsLoading) {
      void this.runPageTask((current) =>
        loadExecApprovals(current, this.resolveExecApprovalsTarget()),
      );
    }
  }

  private syncPolling() {
    if (this.canLoadSystemInfo) {
      this.systemInfoPolling.start();
    } else {
      this.systemInfoPolling.stop();
    }
    if (this.gateway.connected && this.gateway.client) {
      this.polling.start();
      return;
    }
    this.polling.stop();
  }

  private get canLoadSystemInfo(): boolean {
    const snapshot = this.gateway.snapshot;
    return (
      this.isConnected &&
      snapshot?.phase === "connected" &&
      !this.systemInfoUnavailable &&
      isGatewayMethodAdvertised(snapshot, "system.info") === true
    );
  }

  private get canLoadDesktopEnvironments(): boolean {
    const snapshot = this.gateway.snapshot;
    return this.isConnected && Boolean(snapshot && isDesktopPanelAvailable(snapshot));
  }

  private refreshSystemInfo() {
    if (this.canLoadSystemInfo && this.systemInfoTask.status !== TaskStatus.PENDING) {
      void this.systemInfoTask.run();
    }
  }

  private refreshNodeInventory(quiet = false) {
    this.refreshSystemInfo();
    if (this.canLoadDesktopEnvironments && this.environmentsTask.status !== TaskStatus.PENDING) {
      void this.environmentsTask.run();
    }
    void this.runPageTask((pageState) => loadNodes(pageState, { quiet }));
  }

  private resetInventoryDetails() {
    // A replacement source or reconnect must retire callbacks before its data can arrive.
    void this.systemInfoTask.run([null, null]);
    void this.environmentsTask.run([null, null]);
    this.systemInfoPolling.stop();
    this.gatewaySystemInfo = null;
    this.desktopEnvironments = [];
    this.systemInfoUnavailable = false;
  }

  private loadPresence(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.client;
    if (!gateway || !this.gateway.connected || !client) {
      return Promise.resolve();
    }
    return this.presenceTask.run([gateway, client]);
  }

  private cancelPendingConfirmation() {
    this.pendingConfirmation?.abort();
    this.pendingConfirmation = null;
  }

  // A rotation always ends in a dialog: with the replacement when the Gateway issued it
  // to this operator, otherwise with what it did instead. The reveal sits deliberately
  // outside pendingConfirmation, which a reconnect aborts — aborting a shown secret
  // would destroy the only copy the Gateway can hand out.
  private async reportRotationOutcome(
    device: { id: string; name: string },
    role: string,
    scopes?: string[],
  ) {
    if (!this.canManagePairing) {
      return;
    }
    const outcome = await this.runPageTask((pageState) =>
      rotateDeviceToken(pageState, {
        deviceId: device.id,
        gatewayUrl: this.context.gateway.connection.gatewayUrl,
        role,
        scopes,
      }),
    );
    if (!outcome) {
      return;
    }
    await (outcome.delivery === "in-band"
      ? showSecretRevealDialog({
          title: t("devices.inventory.rotatePromptTitle", { role }),
          message: t("devices.inventory.rotatePromptBody"),
          secret: outcome.token,
          acknowledgeLabel: t("devices.inventory.rotateAcknowledge"),
          dismissHint: t("devices.inventory.rotateDismissHint"),
        })
      : showSecretRevealDialog({
          // The title carries the announcement and the device, so the body is only the
          // reassurance. Naming the transient disconnect here would raise an alarm the
          // very next line has to walk back.
          title: t("devices.inventory.rotateWithheldTitle", { device: device.name }),
          status: "success",
          message: t("devices.inventory.rotateWithheldNext"),
          callout: t("devices.inventory.rotateWithheldException"),
          acknowledgeLabel: t("common.close"),
          note: t("devices.inventory.rotateWithheldNote"),
        }));
  }

  private resolveExecApprovalsTarget(): ExecApprovalsTarget {
    return this.execApprovalsTarget === "node" && this.execApprovalsTargetNodeId
      ? { kind: "node", nodeId: this.execApprovalsTargetNodeId }
      : { kind: "gateway" };
  }

  override render() {
    const devices = this.pageState;
    const config = this.context.runtimeConfig.state;
    const gatewaySnapshot = this.context.gateway.snapshot;
    const gatewayVersion =
      gatewaySnapshot.phase === "connected"
        ? gatewaySnapshot.hello?.server?.version?.trim() || null
        : null;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("devices")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("devices")} ${renderLearnMoreLink(DEVICES_DOCS_URL)}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderDevices({
          loading: devices.nodesLoading,
          nodes: devices.nodes,
          presence: this.presence,
          gatewayVersion,
          basePath: this.context.basePath,
          gatewaySystemInfo: this.gatewaySystemInfo,
          desktopEnvironments: this.desktopEnvironments,
          lastError: devices.lastError,
          devicesLoading: devices.devicesLoading,
          devicesError: devices.devicesError,
          devicesList: devices.devicesList,
          canPairDevice: this.canPairDevice,
          canManagePairing: this.canManagePairing,
          canAdmin: this.canAdmin,
          configForm: currentConfigObject(config),
          configLoading: config.configLoading,
          configSaving: config.configSaving,
          configDirty: config.configFormDirty,
          configFormMode: config.configFormMode,
          execApprovalsLoading: devices.execApprovalsLoading,
          execApprovalsSaving: devices.execApprovalsSaving,
          execApprovalsDirty: devices.execApprovalsDirty,
          execApprovalsSnapshot: devices.execApprovalsSnapshot,
          execApprovalsForm: devices.execApprovalsForm,
          execApprovalsSelectedAgent: devices.execApprovalsSelectedAgent,
          execApprovalsTarget: this.execApprovalsTarget,
          execApprovalsTargetNodeId: this.execApprovalsTargetNodeId,
          onDevicePairSetupOpen: () => {
            if (this.canAdmin) {
              void this.context.overlays.openDevicePairSetup();
            }
          },
          onDeviceApprove: (requestId) => {
            if (this.canManagePairing) {
              void this.runPageTask((pageState) => approveDevicePairing(pageState, requestId));
            }
          },
          onDeviceReject: (requestId) =>
            void this.dialogs.confirmPairingReject("device", requestId),
          onNodeApprove: (requestId) => {
            if (this.canManagePairing) {
              void this.runPageTask((pageState) => approveNodePairingRequest(pageState, requestId));
            }
          },
          onNodeReject: (requestId) => void this.dialogs.confirmPairingReject("node", requestId),
          onInventoryRemove: (entry) =>
            void this.dialogs.confirmInventoryRemoval({ kind: "entry", entry }),
          onInventoryCleanup: (entries) => {
            if (entries.length > 0) {
              void this.dialogs.confirmInventoryRemoval({ kind: "stale", entries });
            }
          },
          onDeviceRotate: (device, role, scopes) =>
            void this.reportRotationOutcome(device, role, scopes),
          onDeviceRevoke: (deviceId, role) => void this.dialogs.confirmTokenRevoke(deviceId, role),
          onDeviceRename: (device) => void this.dialogs.editAlias(device),
          onLoadConfig: () =>
            void this.context.runtimeConfig.refresh({ discardPendingChanges: true }),
          onLoadExecApprovals: () =>
            this.canAdmin
              ? void this.runPageTask((pageState) =>
                  loadExecApprovals(pageState, this.resolveExecApprovalsTarget()),
                )
              : undefined,
          onBindDefault: (nodeId) => {
            if (!this.canAdmin) {
              return;
            }
            if (nodeId) {
              this.context.runtimeConfig.patchForm(["tools", "exec", "node"], nodeId);
            } else {
              this.context.runtimeConfig.removeFormValue(["tools", "exec", "node"]);
            }
          },
          onBindAgent: (agentId, nodeId) => {
            if (!this.canAdmin) {
              return;
            }
            const target = this.context.runtimeConfig.agentEntry(agentId, {
              ensure: Boolean(nodeId),
            });
            if (!target) {
              return;
            }
            const path = [...target.path, "tools", "exec", "node"];
            if (nodeId) {
              this.context.runtimeConfig.patchForm(path, nodeId);
            } else {
              this.context.runtimeConfig.removeFormValue(path);
            }
          },
          onSaveBindings: () => {
            if (this.canAdmin) {
              void this.context.runtimeConfig.save();
            }
          },
          onExecApprovalsTargetChange: (kind, nodeId) => {
            this.execApprovalsTarget = kind;
            this.execApprovalsTargetNodeId = nodeId;
            devices.execApprovalsSnapshot = null;
            devices.execApprovalsForm = null;
            devices.execApprovalsDirty = false;
            devices.execApprovalsSelectedAgent = null;
            this.requestUpdate();
          },
          onExecApprovalsSelectAgent: (agentId) => {
            devices.execApprovalsSelectedAgent = agentId;
            this.requestUpdate();
          },
          onExecApprovalsPatch: (path, value) =>
            this.canAdmin
              ? void this.runPageTask((pageState) =>
                  updateExecApprovalsFormValue(pageState, path, value),
                )
              : undefined,
          onExecApprovalsRemove: (path) =>
            this.canAdmin
              ? void this.runPageTask((pageState) => removeExecApprovalsFormValue(pageState, path))
              : undefined,
          onSaveExecApprovals: () =>
            this.canAdmin
              ? void this.runPageTask((pageState) =>
                  saveExecApprovals(pageState, this.resolveExecApprovalsTarget()),
                )
              : undefined,
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-devices-page")) {
  customElements.define("openclaw-devices-page", DevicesPage);
}
