import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import {
  approveDevicePairing,
  approveNodePairingRequest,
  createInitialNodesState,
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
  type DevicePairingList,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
  type ExecApprovalsTarget,
  type NodesPageDataState,
} from "../../lib/nodes/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderNodes } from "./view.ts";

export type NodesRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  nodes: NodesPageDataState;
};

const NODES_ACTIVE_POLL_INTERVAL_MS = 30_000;

class NodesPage extends OpenClawLightDomElement implements NodesPageDataState {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: NodesRouteData;

  @state() client: NodesPageDataState["client"] = null;
  @state() connected = false;
  requestGeneration = 0;
  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() lastError: string | null = null;
  @state() chatError: string | null = null;
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() private canPairDevice = false;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() private execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() private execApprovalsTargetNodeId: string | null = null;

  private routeDataInitialized = false;
  private hasBoundGateway = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private nodesPollInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const initialBind = !this.hasBoundGateway;
        this.hasBoundGateway = true;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, !initialBind, initialBind);
        const stop = gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway) {
            this.applyGatewaySnapshot(snapshot, false);
          }
        });
        return () => {
          stop();
          if (this.gatewaySource === gateway) {
            this.gatewaySource = null;
          }
        };
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
            void loadDevices(this, { quiet: true });
          }
          if (event.event === "node.pair.requested" || event.event === "node.pair.resolved") {
            void loadNodes(this, { quiet: true });
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
    this.stopPolling();
    this.subscriptions.clear();
    this.requestGeneration += 1;
    this.client = null;
    this.connected = false;
    this.canPairDevice = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationGatewaySnapshot,
    forceReset: boolean,
    initialBind = false,
  ) {
    const clientChanged = this.client !== snapshot.client;
    const connectionChanged = this.connected !== snapshot.connected;
    if (forceReset || clientChanged || connectionChanged || !snapshot.connected) {
      this.requestGeneration += 1;
    }
    this.syncGatewayState(snapshot);
    if (forceReset || (!initialBind && (clientChanged || !snapshot.connected))) {
      this.resetServerState(snapshot);
    }
    this.syncPolling();
    this.ensureInitialData();
  }

  private syncGatewayState(snapshot: ApplicationGatewaySnapshot) {
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.canPairDevice = snapshot.connected && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    if (data.gateway !== gateway || data.gatewaySnapshot !== snapshot) {
      this.resetServerState(snapshot);
      this.ensureInitialData();
      return;
    }
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.nodesLoading = data.nodes.nodesLoading;
    this.nodes = data.nodes.nodes;
    this.lastError = data.nodes.lastError;
    this.chatError = data.nodes.chatError ?? null;
    this.devicesLoading = data.nodes.devicesLoading;
    this.devicesError = data.nodes.devicesError;
    this.devicesList = data.nodes.devicesList;
    this.execApprovalsLoading = data.nodes.execApprovalsLoading;
    this.execApprovalsSaving = data.nodes.execApprovalsSaving;
    this.execApprovalsDirty = data.nodes.execApprovalsDirty;
    this.execApprovalsSnapshot = data.nodes.execApprovalsSnapshot;
    this.execApprovalsForm = data.nodes.execApprovalsForm;
    this.execApprovalsSelectedAgent = data.nodes.execApprovalsSelectedAgent;
  }

  private resetServerState(snapshot: ApplicationGatewaySnapshot) {
    const next = createInitialNodesState(snapshot);
    this.nodesLoading = next.nodesLoading;
    this.nodes = next.nodes;
    this.lastError = next.lastError;
    this.chatError = next.chatError ?? null;
    this.devicesLoading = next.devicesLoading;
    this.devicesError = next.devicesError;
    this.devicesList = next.devicesList;
    this.execApprovalsLoading = next.execApprovalsLoading;
    this.execApprovalsSaving = next.execApprovalsSaving;
    this.execApprovalsDirty = next.execApprovalsDirty;
    this.execApprovalsSnapshot = next.execApprovalsSnapshot;
    this.execApprovalsForm = next.execApprovalsForm;
    this.execApprovalsSelectedAgent = next.execApprovalsSelectedAgent;
  }

  private ensureInitialData() {
    if (!this.connected || !this.client || !this.routeDataInitialized) {
      return;
    }
    if (!this.nodes.length && !this.nodesLoading) {
      void loadNodes(this);
    }
    if (!this.devicesList && !this.devicesLoading) {
      void loadDevices(this);
    }
    const config = this.context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void this.context.runtimeConfig.refresh();
    }
    if (!this.execApprovalsSnapshot && !this.execApprovalsLoading) {
      void loadExecApprovals(this, this.resolveExecApprovalsTarget());
    }
  }

  private syncPolling() {
    if (this.connected && this.client) {
      if (this.nodesPollInterval == null) {
        this.nodesPollInterval = globalThis.setInterval(() => {
          void loadNodes(this, { quiet: true });
        }, NODES_ACTIVE_POLL_INTERVAL_MS);
      }
      return;
    }
    this.stopPolling();
  }

  private stopPolling() {
    if (this.nodesPollInterval == null) {
      return;
    }
    clearInterval(this.nodesPollInterval);
    this.nodesPollInterval = null;
  }

  private resolveExecApprovalsTarget(): ExecApprovalsTarget {
    return this.execApprovalsTarget === "node" && this.execApprovalsTargetNodeId
      ? { kind: "node", nodeId: this.execApprovalsTargetNodeId }
      : { kind: "gateway" };
  }

  override render() {
    const config = this.context.runtimeConfig.state;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("nodes")}</div>
          <div class="page-sub">${subtitleForRoute("nodes")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderNodes({
          loading: this.nodesLoading,
          nodes: this.nodes,
          lastError: this.lastError,
          devicesLoading: this.devicesLoading,
          devicesError: this.devicesError,
          devicesList: this.devicesList,
          canPairDevice: this.canPairDevice,
          configForm: currentConfigObject(config),
          configLoading: config.configLoading,
          configSaving: config.configSaving,
          configDirty: config.configFormDirty,
          configFormMode: config.configFormMode,
          execApprovalsLoading: this.execApprovalsLoading,
          execApprovalsSaving: this.execApprovalsSaving,
          execApprovalsDirty: this.execApprovalsDirty,
          execApprovalsSnapshot: this.execApprovalsSnapshot,
          execApprovalsForm: this.execApprovalsForm,
          execApprovalsSelectedAgent: this.execApprovalsSelectedAgent,
          execApprovalsTarget: this.execApprovalsTarget,
          execApprovalsTargetNodeId: this.execApprovalsTargetNodeId,
          onRefresh: () => {
            void loadNodes(this);
            void loadDevices(this);
          },
          onDevicePairSetupOpen: () => void this.context.overlays.openDevicePairSetup(),
          onDeviceApprove: (requestId) => void approveDevicePairing(this, requestId),
          onDeviceReject: (requestId) => void rejectDevicePairing(this, requestId),
          onNodeApprove: (requestId) => void approveNodePairingRequest(this, requestId),
          onNodeReject: (requestId) => void rejectNodePairingRequest(this, requestId),
          onInventoryRemove: (entry) => void removeInventoryEntry(this, entry),
          onInventoryCleanup: (entries) => void removeStaleInventoryEntries(this, entries),
          onDeviceRotate: (deviceId, role, scopes) =>
            void rotateDeviceToken(this, {
              deviceId,
              gatewayUrl: this.context.gateway.connection.gatewayUrl,
              role,
              scopes,
            }),
          onDeviceRevoke: (deviceId, role) =>
            void revokeDeviceToken(this, {
              deviceId,
              gatewayUrl: this.context.gateway.connection.gatewayUrl,
              role,
            }),
          onLoadConfig: () =>
            void this.context.runtimeConfig.refresh({ discardPendingChanges: true }),
          onLoadExecApprovals: () =>
            void loadExecApprovals(this, this.resolveExecApprovalsTarget()),
          onBindDefault: (nodeId) => {
            if (nodeId) {
              this.context.runtimeConfig.patchForm(["tools", "exec", "node"], nodeId);
            } else {
              this.context.runtimeConfig.removeFormValue(["tools", "exec", "node"]);
            }
          },
          onBindAgent: (agentIndex, nodeId) => {
            const path = ["agents", "list", agentIndex, "tools", "exec", "node"];
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
            this.execApprovalsSnapshot = null;
            this.execApprovalsForm = null;
            this.execApprovalsDirty = false;
            this.execApprovalsSelectedAgent = null;
          },
          onExecApprovalsSelectAgent: (agentId) => {
            this.execApprovalsSelectedAgent = agentId;
          },
          onExecApprovalsPatch: (path, value) => updateExecApprovalsFormValue(this, path, value),
          onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(this, path),
          onSaveExecApprovals: () =>
            void saveExecApprovals(this, this.resolveExecApprovalsTarget()),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-nodes-page")) {
  customElements.define("openclaw-nodes-page", NodesPage);
}
