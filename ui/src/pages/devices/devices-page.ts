import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import { showSecretRevealDialog } from "../../components/secret-reveal-dialog.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import {
  approveDevicePairing,
  approveNodePairingRequest,
  createInitialDevicesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
  rejectDevicePairing,
  rejectNodePairingRequest,
  removeExecApprovalsFormValue,
  removeInventoryEntry,
  removeStaleInventoryEntries,
  revokeDeviceToken,
  rotateDeviceToken,
  saveExecApprovals,
  updateExecApprovalsFormValue,
  type ExecApprovalsTarget,
  type InventoryRemovalRequest,
  type DevicesPageDataState,
} from "../../lib/nodes/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderDevices } from "./view.ts";

const DEVICES_DOCS_URL = "https://docs.openclaw.ai/nodes";

export type DevicesRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  devices: DevicesPageDataState;
};

const DEVICES_ACTIVE_POLL_INTERVAL_MS = 30_000;

type InventoryRemovalPrompt =
  | { kind: "entry"; entry: InventoryRemovalRequest }
  | { kind: "stale"; entries: InventoryRemovalRequest[] };

function readPresence(value: unknown): PresenceEntry[] | null {
  const presence =
    value && typeof value === "object" ? (value as { presence?: unknown }).presence : null;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : null;
}

function presenceConnectivitySignature(entries: PresenceEntry[]): string {
  const states = new Map<string, "connected" | "offline">();
  for (const entry of entries) {
    const id = (entry.deviceId ?? entry.instanceId)?.trim().toLowerCase();
    if (!id || entry.mode?.trim().toLowerCase() === "gateway") {
      continue;
    }
    states.set(id, entry.reason?.trim().toLowerCase() === "disconnect" ? "offline" : "connected");
  }
  return JSON.stringify([...states].toSorted(([left], [right]) => left.localeCompare(right)));
}

class DevicesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: DevicesRouteData;

  @state() presence: PresenceEntry[] = [];
  @state() private pageState = createInitialDevicesState();
  @state() private canPairDevice = false;
  @state() private execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() private execApprovalsTargetNodeId: string | null = null;
  private pendingConfirmation: AbortController | null = null;

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
  private readonly polling = new PollController(
    this,
    DEVICES_ACTIVE_POLL_INTERVAL_MS,
    () => {
      void this.runPageTask((pageState) => loadNodes(pageState, { quiet: true }));
      void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
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
          const presence = event.event === "presence" ? readPresence(event.payload) : null;
          if (presence) {
            const connectivityChanged =
              presenceConnectivitySignature(presence) !==
              presenceConnectivitySignature(this.presence);
            void this.presenceTask.run([null, null]);
            this.presence = presence;
            if (connectivityChanged) {
              void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
              void this.runPageTask((pageState) => loadNodes(pageState, { quiet: true }));
            }
          }
          if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
            void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
          }
          if (event.event === "node.pair.requested" || event.event === "node.pair.resolved") {
            void this.runPageTask((pageState) => loadNodes(pageState, { quiet: true }));
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
    this.presence = [];
    this.canPairDevice = false;
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
    if (
      this.routeDataInitialized &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      (change.identityChanged || change.connectionChanged)
    ) {
      const initialPresence = readPresence(snapshot.hello?.snapshot);
      this.presence = initialPresence ?? [];
      void this.loadPresence();
    }
    this.syncPolling();
  }

  private syncGatewayState(snapshot: ApplicationGatewaySnapshot) {
    this.canPairDevice =
      snapshot.phase === "connected" && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
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
      this.presence = readPresence(snapshot.hello?.snapshot) ?? [];
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
    const initialPresence = readPresence(snapshot.hello?.snapshot);
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
      void this.runPageTask((current) => loadNodes(current));
    }
    if (!pageState.devicesList && !pageState.devicesLoading) {
      void this.runPageTask((current) => loadDevices(current));
    }
    const config = this.context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void this.context.runtimeConfig.refresh();
    }
    if (!pageState.execApprovalsSnapshot && !pageState.execApprovalsLoading) {
      void this.runPageTask((current) =>
        loadExecApprovals(current, this.resolveExecApprovalsTarget()),
      );
    }
  }

  private syncPolling() {
    if (this.gateway.connected && this.gateway.client) {
      this.polling.start();
      return;
    }
    this.polling.stop();
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

  // Every destructive Devices action confirms here, never through window.confirm: the
  // awaited dialog lets the gateway reconnect or swap clients mid-prompt, so the captured
  // scope is revalidated before the operation runs against a different server.
  private async confirmDestructiveAction(
    prompt: Omit<ConfirmDialogOptions, "danger" | "signal">,
    run: (pageState: DevicesPageDataState) => unknown,
  ) {
    if (this.pendingConfirmation) {
      return;
    }
    const controller = new AbortController();
    this.pendingConfirmation = controller;
    const generation = this.requestGeneration;
    const client = this.gateway.client;
    const confirmed = await showConfirmDialog({
      ...prompt,
      danger: true,
      signal: controller.signal,
    });
    if (this.pendingConfirmation === controller) {
      this.pendingConfirmation = null;
    }
    if (
      !confirmed ||
      controller.signal.aborted ||
      generation !== this.requestGeneration ||
      client !== this.gateway.client ||
      !this.gateway.connected
    ) {
      return;
    }
    await this.runPageTask(run);
  }

  private confirmInventoryRemoval(prompt: InventoryRemovalPrompt) {
    if (prompt.kind === "entry") {
      const entry = prompt.entry;
      return this.confirmDestructiveAction(
        {
          title: t("devices.inventory.removePromptTitle", { name: entry.name }),
          message: t("devices.inventory.removePromptBody"),
          details: t("devices.inventory.deviceId", { id: entry.id }),
          confirmLabel: t("devices.inventory.remove"),
        },
        (pageState) => removeInventoryEntry(pageState, entry),
      );
    }
    const entries = prompt.entries;
    return this.confirmDestructiveAction(
      {
        title: t(
          entries.length === 1
            ? "devices.inventory.removeStalePromptTitleOne"
            : "devices.inventory.removeStalePromptTitle",
          { count: String(entries.length) },
        ),
        message: t("devices.inventory.removeStalePromptBody"),
        confirmLabel: t("devices.inventory.remove"),
      },
      (pageState) => removeStaleInventoryEntries(pageState, entries),
    );
  }

  private confirmPairingReject(target: "device" | "node", requestId: string) {
    return this.confirmDestructiveAction(
      {
        title: t(
          target === "device"
            ? "devices.inventory.rejectDevicePromptTitle"
            : "devices.inventory.rejectNodePromptTitle",
        ),
        message: t("devices.inventory.rejectPromptBody"),
        confirmLabel: t("devices.inventory.reject"),
      },
      (pageState) =>
        target === "device"
          ? rejectDevicePairing(pageState, requestId)
          : rejectNodePairingRequest(pageState, requestId),
    );
  }

  private confirmTokenRevoke(deviceId: string, role: string) {
    return this.confirmDestructiveAction(
      {
        title: t("devices.inventory.revokePromptTitle", { role }),
        message: t("devices.inventory.revokePromptBody"),
        details: t("devices.inventory.deviceId", { id: deviceId }),
        confirmLabel: t("devices.inventory.revoke"),
      },
      (pageState) =>
        revokeDeviceToken(pageState, {
          deviceId,
          gatewayUrl: this.context.gateway.connection.gatewayUrl,
          role,
        }),
    );
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
            ${subtitleForRoute("devices")}
            ${renderDocsLink(DEVICES_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderDevices({
          loading: devices.nodesLoading,
          nodes: devices.nodes,
          presence: this.presence,
          gatewayVersion,
          lastError: devices.lastError,
          devicesLoading: devices.devicesLoading,
          devicesError: devices.devicesError,
          devicesList: devices.devicesList,
          canPairDevice: this.canPairDevice,
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
          onDevicePairSetupOpen: () => void this.context.overlays.openDevicePairSetup(),
          onDeviceApprove: (requestId) =>
            void this.runPageTask((pageState) => approveDevicePairing(pageState, requestId)),
          onDeviceReject: (requestId) => void this.confirmPairingReject("device", requestId),
          onNodeApprove: (requestId) =>
            void this.runPageTask((pageState) => approveNodePairingRequest(pageState, requestId)),
          onNodeReject: (requestId) => void this.confirmPairingReject("node", requestId),
          onInventoryRemove: (entry) => void this.confirmInventoryRemoval({ kind: "entry", entry }),
          onInventoryCleanup: (entries) => {
            if (entries.length > 0) {
              void this.confirmInventoryRemoval({ kind: "stale", entries });
            }
          },
          onDeviceRotate: (device, role, scopes) =>
            void this.reportRotationOutcome(device, role, scopes),
          onDeviceRevoke: (deviceId, role) => void this.confirmTokenRevoke(deviceId, role),
          onLoadConfig: () =>
            void this.context.runtimeConfig.refresh({ discardPendingChanges: true }),
          onLoadExecApprovals: () =>
            void this.runPageTask((pageState) =>
              loadExecApprovals(pageState, this.resolveExecApprovalsTarget()),
            ),
          onBindDefault: (nodeId) => {
            if (nodeId) {
              this.context.runtimeConfig.patchForm(["tools", "exec", "node"], nodeId);
            } else {
              this.context.runtimeConfig.removeFormValue(["tools", "exec", "node"]);
            }
          },
          onBindAgent: (agentId, nodeId) => {
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
          onSaveBindings: () => void this.context.runtimeConfig.save(),
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
            void this.runPageTask((pageState) =>
              updateExecApprovalsFormValue(pageState, path, value),
            ),
          onExecApprovalsRemove: (path) =>
            void this.runPageTask((pageState) => removeExecApprovalsFormValue(pageState, path)),
          onSaveExecApprovals: () =>
            void this.runPageTask((pageState) =>
              saveExecApprovals(pageState, this.resolveExecApprovalsTarget()),
            ),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-devices-page")) {
  customElements.define("openclaw-devices-page", DevicesPage);
}
