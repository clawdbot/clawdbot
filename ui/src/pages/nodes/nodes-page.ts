import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import {
  approveDevicePairing,
  createInitialNodesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
  rejectDevicePairing,
  removeExecApprovalsFormValue,
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
import { renderNodes } from "./view.ts";

export type NodesRouteData = {
  nodes: NodesPageDataState;
};

const NODES_ACTIVE_POLL_INTERVAL_MS = 30_000;

class NodesPage extends LitElement implements NodesPageDataState {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: NodesRouteData;

  @state() client: NodesPageDataState["client"] = null;
  @state() connected = false;
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
  private stopGatewaySubscription?: () => void;
  private stopGatewayEvents?: () => void;
  private stopConfigSubscription?: () => void;
  private nodesPollInterval: ReturnType<typeof globalThis.setInterval> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      const previousClient = this.client;
      this.syncGatewayState();
      if (previousClient !== snapshot.client || !snapshot.connected) {
        this.resetServerState();
      }
      this.syncPolling();
      this.ensureInitialData();
    });
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
        void loadDevices(this, { quiet: true });
      }
    });
    this.stopConfigSubscription = this.context.runtimeConfig.subscribe(() => this.requestUpdate());
    this.syncPolling();
    this.ensureInitialData();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
    }
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData")) {
      this.ensureInitialData();
    }
  }

  override disconnectedCallback() {
    this.stopPolling();
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    super.disconnectedCallback();
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    this.client = gateway.client;
    this.connected = gateway.connected;
    this.canPairDevice = gateway.connected && hasOperatorAdminAccess(gateway.hello?.auth ?? null);
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    const gateway = this.context.gateway.snapshot;
    if (data.nodes.client !== gateway.client) {
      this.syncGatewayState();
      return;
    }
    this.client = gateway.client;
    this.connected = gateway.connected;
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

  private resetServerState() {
    const next = createInitialNodesState(this.context.gateway.snapshot);
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
        this.context.basePath,
        renderNodes({
          loading: this.nodesLoading,
          nodes: this.nodes,
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
          onRefresh: () => void loadNodes(this),
          onDevicesRefresh: () => void loadDevices(this),
          onDevicePairSetupOpen: () => void this.context.overlays.openDevicePairSetup(),
          onDeviceApprove: (requestId) => void approveDevicePairing(this, requestId),
          onDeviceReject: (requestId) => void rejectDevicePairing(this, requestId),
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
        "nodes",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

if (!customElements.get("openclaw-nodes-page")) {
  customElements.define("openclaw-nodes-page", NodesPage);
}
