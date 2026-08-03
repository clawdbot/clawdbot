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
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
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
  type ExecApprovalsTarget,
  type InventoryRemovalRequest,
  type NodesPageDataState,
} from "../../lib/nodes/index.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderNodes } from "./view.ts";

const NODES_DOCS_URL = "https://docs.openclaw.ai/nodes";

export type NodesRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  nodes: NodesPageDataState;
};

const NODES_ACTIVE_POLL_INTERVAL_MS = 30_000;

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

class NodesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: NodesRouteData;

  @state() presence: PresenceEntry[] = [];
  @state() private nodeState = createInitialNodesState();
  @state() private canPairDevice = false;
  @state() private execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() private execApprovalsTargetNodeId: string | null = null;
  private inventoryRemovalConfirmation: AbortController | null = null;

  private routeDataInitialized = false;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: (change) => this.resetServerState(change.snapshot),
    invalidateRequests: (change) => {
      this.nodeState.requestGeneration = this.gateway.epoch;
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
    NODES_ACTIVE_POLL_INTERVAL_MS,
    () => {
      void this.runNodeTask((nodeState) => loadNodes(nodeState, { quiet: true }));
      void this.runNodeTask((nodeState) => loadDevices(nodeState, { quiet: true }));
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
              void this.runNodeTask((nodeState) => loadDevices(nodeState, { quiet: true }));
              void this.runNodeTask((nodeState) => loadNodes(nodeState, { quiet: true }));
            }
          }
          if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
            void this.runNodeTask((nodeState) => loadDevices(nodeState, { quiet: true }));
          }
          if (event.event === "node.pair.requested" || event.event === "node.pair.resolved") {
            void this.runNodeTask((nodeState) => loadNodes(nodeState, { quiet: true }));
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
    this.cancelInventoryRemovalConfirmation();
    this.subscriptions.clear();
    void this.presenceTask.run([null, null]);
    this.presence = [];
    this.canPairDevice = false;
    super.disconnectedCallback();
  }

  get requestGeneration(): number {
    return this.nodeState.requestGeneration;
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    this.nodeState.client = snapshot.client;
    this.nodeState.connected = snapshot.phase === "connected";
    this.nodeState.requestGeneration = this.gateway.epoch;
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
    this.nodeState = {
      ...data.nodes,
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
    this.cancelInventoryRemovalConfirmation();
    this.nodeState.requestGeneration += 1;
    const next = createInitialNodesState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
    next.requestGeneration = this.gateway.epoch;
    this.nodeState = next;
    void this.presenceTask.run([null, null]);
    this.presence = [];
  }

  private async runNodeTask<T>(
    task: (nodeState: NodesPageDataState) => T | Promise<T>,
  ): Promise<T> {
    const nodeState = this.nodeState;
    try {
      const result = task(nodeState);
      if (this.nodeState === nodeState) {
        this.requestUpdate();
      }
      return await result;
    } finally {
      if (this.nodeState === nodeState) {
        this.requestUpdate();
      }
    }
  }

  private ensureInitialData() {
    const nodeState = this.nodeState;
    if (!nodeState.connected || !nodeState.client || !this.routeDataInitialized) {
      return;
    }
    if (!nodeState.nodes.length && !nodeState.nodesLoading) {
      void this.runNodeTask((current) => loadNodes(current));
    }
    if (!nodeState.devicesList && !nodeState.devicesLoading) {
      void this.runNodeTask((current) => loadDevices(current));
    }
    const config = this.context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void this.context.runtimeConfig.refresh();
    }
    if (!nodeState.execApprovalsSnapshot && !nodeState.execApprovalsLoading) {
      void this.runNodeTask((current) =>
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

  private cancelInventoryRemovalConfirmation() {
    this.inventoryRemovalConfirmation?.abort();
    this.inventoryRemovalConfirmation = null;
  }

  private async confirmInventoryRemoval(prompt: InventoryRemovalPrompt) {
    if (this.inventoryRemovalConfirmation) {
      return;
    }
    const controller = new AbortController();
    this.inventoryRemovalConfirmation = controller;
    const generation = this.requestGeneration;
    const client = this.gateway.client;
    const title =
      prompt.kind === "entry"
        ? t("nodes.inventory.removePromptTitle", { name: prompt.entry.name })
        : t(
            prompt.entries.length === 1
              ? "nodes.inventory.removeStalePromptTitleOne"
              : "nodes.inventory.removeStalePromptTitle",
            { count: String(prompt.entries.length) },
          );
    const confirmed = await showConfirmDialog({
      title,
      message: t(
        prompt.kind === "entry"
          ? "nodes.inventory.removePromptBody"
          : "nodes.inventory.removeStalePromptBody",
      ),
      details:
        prompt.kind === "entry"
          ? t("nodes.inventory.deviceId", { id: prompt.entry.id })
          : undefined,
      confirmLabel: t("nodes.inventory.remove"),
      danger: true,
      signal: controller.signal,
    });
    if (this.inventoryRemovalConfirmation === controller) {
      this.inventoryRemovalConfirmation = null;
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
    if (prompt.kind === "entry") {
      void this.runNodeTask((nodeState) => removeInventoryEntry(nodeState, prompt.entry));
      return;
    }
    void this.runNodeTask((nodeState) => removeStaleInventoryEntries(nodeState, prompt.entries));
  }

  private resolveExecApprovalsTarget(): ExecApprovalsTarget {
    return this.execApprovalsTarget === "node" && this.execApprovalsTargetNodeId
      ? { kind: "node", nodeId: this.execApprovalsTargetNodeId }
      : { kind: "gateway" };
  }

  override render() {
    const nodes = this.nodeState;
    const config = this.context.runtimeConfig.state;
    const gatewaySnapshot = this.context.gateway.snapshot;
    const gatewayVersion =
      gatewaySnapshot.phase === "connected"
        ? gatewaySnapshot.hello?.server?.version?.trim() || null
        : null;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("nodes")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("nodes")} ${renderDocsLink(NODES_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderNodes({
          loading: nodes.nodesLoading,
          nodes: nodes.nodes,
          presence: this.presence,
          gatewayVersion,
          lastError: nodes.lastError,
          devicesLoading: nodes.devicesLoading,
          devicesError: nodes.devicesError,
          devicesList: nodes.devicesList,
          canPairDevice: this.canPairDevice,
          configForm: currentConfigObject(config),
          configLoading: config.configLoading,
          configSaving: config.configSaving,
          configDirty: config.configFormDirty,
          configFormMode: config.configFormMode,
          execApprovalsLoading: nodes.execApprovalsLoading,
          execApprovalsSaving: nodes.execApprovalsSaving,
          execApprovalsDirty: nodes.execApprovalsDirty,
          execApprovalsSnapshot: nodes.execApprovalsSnapshot,
          execApprovalsForm: nodes.execApprovalsForm,
          execApprovalsSelectedAgent: nodes.execApprovalsSelectedAgent,
          execApprovalsTarget: this.execApprovalsTarget,
          execApprovalsTargetNodeId: this.execApprovalsTargetNodeId,
          onDevicePairSetupOpen: () => void this.context.overlays.openDevicePairSetup(),
          onDeviceApprove: (requestId) =>
            void this.runNodeTask((nodeState) => approveDevicePairing(nodeState, requestId)),
          onDeviceReject: (requestId) =>
            void this.runNodeTask((nodeState) => rejectDevicePairing(nodeState, requestId)),
          onNodeApprove: (requestId) =>
            void this.runNodeTask((nodeState) => approveNodePairingRequest(nodeState, requestId)),
          onNodeReject: (requestId) =>
            void this.runNodeTask((nodeState) => rejectNodePairingRequest(nodeState, requestId)),
          onInventoryRemove: (entry) => void this.confirmInventoryRemoval({ kind: "entry", entry }),
          onInventoryCleanup: (entries) => {
            if (entries.length > 0) {
              void this.confirmInventoryRemoval({ kind: "stale", entries });
            }
          },
          onDeviceRotate: (deviceId, role, scopes) =>
            void this.runNodeTask((nodeState) =>
              rotateDeviceToken(nodeState, {
                deviceId,
                gatewayUrl: this.context.gateway.connection.gatewayUrl,
                role,
                scopes,
              }),
            ),
          onDeviceRevoke: (deviceId, role) =>
            void this.runNodeTask((nodeState) =>
              revokeDeviceToken(nodeState, {
                deviceId,
                gatewayUrl: this.context.gateway.connection.gatewayUrl,
                role,
              }),
            ),
          onLoadConfig: () =>
            void this.context.runtimeConfig.refresh({ discardPendingChanges: true }),
          onLoadExecApprovals: () =>
            void this.runNodeTask((nodeState) =>
              loadExecApprovals(nodeState, this.resolveExecApprovalsTarget()),
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
            nodes.execApprovalsSnapshot = null;
            nodes.execApprovalsForm = null;
            nodes.execApprovalsDirty = false;
            nodes.execApprovalsSelectedAgent = null;
            this.requestUpdate();
          },
          onExecApprovalsSelectAgent: (agentId) => {
            nodes.execApprovalsSelectedAgent = agentId;
            this.requestUpdate();
          },
          onExecApprovalsPatch: (path, value) =>
            void this.runNodeTask((nodeState) =>
              updateExecApprovalsFormValue(nodeState, path, value),
            ),
          onExecApprovalsRemove: (path) =>
            void this.runNodeTask((nodeState) => removeExecApprovalsFormValue(nodeState, path)),
          onSaveExecApprovals: () =>
            void this.runNodeTask((nodeState) =>
              saveExecApprovals(nodeState, this.resolveExecApprovalsTarget()),
            ),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-nodes-page")) {
  customElements.define("openclaw-nodes-page", NodesPage);
}
