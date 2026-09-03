// Gateway node registry.
// Tracks connected node clients, invoke requests, broadcasts, and system.run approvals.
import { expectDefined } from "@openclaw/normalization-core";
import {
  addTimerTimeoutGraceMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
// NodeSession is plugin-SDK-reachable; importing these types from the
// gateway-protocol index would retain the whole ProtocolSchemas registry in
// the public plugin-sdk dts (check-plugin-sdk-exports guards this).
import type {
  NodeHostStatsPayload,
  NodePluginToolDescriptor,
  NodeSkillDescriptor,
} from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActiveNodeContext } from "../infra/active-node-context.js";
import type { PairedDeviceNodeBinding } from "../infra/device-pairing-node-state.js";
import { isPrivateNodeInvokeCommand, NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import {
  intersectNodePermissionSurface,
  type NodeApprovalSurface,
} from "../infra/node-pairing-surface.js";
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import {
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  replaceRemoteNodeSkills,
} from "../skills/runtime/remote-skills.js";
import {
  resolveNodeCommandAllowlist,
  retainFulfilledNodeCapabilities,
} from "./node-command-policy.js";
import { resolveEffectiveComputerUseDescriptor } from "./node-computer-use-descriptor.js";
import { serializeNodeEvent } from "./node-invoke-request.js";
import {
  createRegisteredNodePluginToolDescriptorMap,
  normalizeNodePluginToolDescriptors,
  removeConnectedNodePluginTools,
  replaceConnectedNodePluginTools,
  type RegisteredNodePluginToolCommand,
} from "./node-plugin-tool-snapshot.js";
import {
  forgetNodeRunnerInventory,
  invokeLifecycleNodeRegistry,
  invokePublicNodeRegistry,
  isNodeRegistryPendingInvokeConnectionActive,
  reconcileNodeRunnerAvailability,
  registerNodeRegistryPrivateRuntime,
  settleNodeRegistryPairingGenerationChange,
} from "./node-registry-private.js";
import {
  NodeInvokeStreamController,
  type NodeInvokeProgressParams,
  type NodeInvokeResultParams,
  type PendingInvoke,
  type PendingSystemRunEvent,
} from "./node-registry.invoke-stream.js";
import { isNodeWorkerHostClientId } from "./node-runner-inventory-runtime.js";
import { normalizeNodeSkillDescriptors } from "./node-skill-descriptors.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

/** Connected node session advertised over Gateway websocket. */
export type NodeSession = {
  nodeId: string;
  connId: string;
  /** Persistent device key and node-token identity authenticated for this connection. */
  pairingIdentity?: string;
  /** Persistent pairing generation authenticated before this session was registered. */
  pairingGeneration?: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  declaredCaps: string[];
  sessionCapsCeiling?: string[];
  caps: string[];
  declaredCommands: string[];
  sessionCommandsCeiling?: string[];
  commands: string[];
  declaredComputerUse?: ComputerUseCapabilityDescriptor;
  computerUse?: ComputerUseCapabilityDescriptor;
  declaredNodePluginTools: NodePluginToolDescriptor[];
  nodePluginTools: NodePluginToolDescriptor[];
  nodeSkills: NodeSkillDescriptor[];
  declaredPermissions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
  lastActiveAtMs?: number;
  presenceUpdatedAtMs?: number;
  hostStats?: NodeHostStats;
};

type PairingBoundNodeSession = NodeSession & { pairingIdentity: string };
export type NodeSessionConnectParams = GatewayWsClient["connect"] &
  Partial<
    Pick<
      NodeSession,
      | "declaredCaps"
      | "declaredCommands"
      | "declaredComputerUse"
      | "declaredPermissions"
      | "sessionCapsCeiling"
      | "sessionCommandsCeiling"
      | "coreVersion"
      | "uiVersion"
    >
  > & {
    withheldCommands?: string[];
  };

type NodeSessionPolicy = {
  approvedCaps: string[];
  approvedCommands: string[];
  skills: NodeSkillDescriptor[];
  withheldCommands: readonly string[];
};
const NODE_SESSION_POLICIES = new WeakMap<object, NodeSessionPolicy>();

/** Reads commands withheld by current policy from the live session's declaration. */
export function readNodeSessionWithheldCommands(node: object): readonly string[] {
  return NODE_SESSION_POLICIES.get(node)?.withheldCommands ?? [];
}

type PairingBoundNodeSessionLease = {
  session: PairingBoundNodeSession;
  nodeId: string;
  connId: string;
  binding: PairedDeviceNodeBinding;
};

type PairingLeaseResolution =
  | { status: "current"; session: PairingBoundNodeSession }
  | { status: "stale"; presenceInvalidated: boolean }
  | { status: "unavailable" };

/** Authorized system.run event window bound to one node connection. */
type AuthorizedSystemRunEvent = PendingSystemRunEvent & {
  nodeId: string;
  connId: string;
  expiresAtMs: number | null;
};

/** Result payload returned from node.invoke. */
export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

/** Connectivity probe result for a registered node. */
export type NodeConnectivityResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/** Minimal websocket ping/pong surface used by connectivity checks. */
type PingableSocket = {
  ping?: (data?: Buffer, mask?: boolean, cb?: (err?: Error) => void) => void;
  once?: (event: "pong" | "close" | "error", listener: (...args: unknown[]) => void) => unknown;
  off?: (event: "pong" | "close" | "error", listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (
    event: "pong" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ) => unknown;
};

const SERIALIZED_EVENT_PAYLOAD = Symbol("openclaw.serializedEventPayload");
const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;
const SLOW_CONSUMER_CLOSE_CODE = 1008;
const FAILED_EVENT_LOG_INTERVAL_MS = 30_000;
const log = createSubsystemLogger("gateway/nodes");
const failedEventLogAtByNode = new WeakMap<NodeSession, number>();
export type SerializedEventPayload = {
  readonly json: string;
  readonly [SERIALIZED_EVENT_PAYLOAD]: true;
};

/** Event transport for nodes that cannot keep a WebSocket open, such as watchOS. */
export type NodeEventTransport = {
  send: (event: string, payload: unknown) => boolean;
  sendRaw: (event: string, payloadJSON?: SerializedEventPayload | null) => boolean;
  checkConnectivity?: (timeoutMs: number) => Promise<NodeConnectivityResult>;
};

type PairedDeviceNodeBindingSnapshot = PairedDeviceNodeBinding;

type NodeSessionRegistrationOptions = {
  remoteIp?: string | undefined;
  pairingIdentity: string;
  pairingGeneration?: string | undefined;
  approvedSurface?: NodeApprovalSurface;
};

function pairingBindingForSession(node: PairingBoundNodeSession): PairedDeviceNodeBinding {
  return {
    identity: node.pairingIdentity,
    ...(node.pairingGeneration ? { generation: node.pairingGeneration } : {}),
  };
}

function pairingStateMatchesBinding(
  binding: PairedDeviceNodeBinding,
  current: PairedDeviceNodeBindingSnapshot | undefined,
): boolean {
  if (!current) {
    return false;
  }
  if (binding.identity !== current.identity) {
    return false;
  }
  return !binding.generation || binding.generation === current.generation;
}

export type NodeRegistryOptions = {
  listRegisteredNodePluginToolCommands?:
    | (() => readonly RegisteredNodePluginToolCommand[] | undefined)
    | undefined;
  getConfig?: () => OpenClawConfig;
  resolveCurrentPairingState?: (
    nodeId: string,
  ) => Promise<PairedDeviceNodeBindingSnapshot | undefined>;
  isPairingStateCurrent?: (nodeId: string, expected: PairedDeviceNodeBinding) => boolean;
  onPairingGenerationChanged?: (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSessionState: boolean;
  }) => void;
  onPairingInvalidated?: (params: { nodeId: string; connId: string }) => void;
};

/** Serialize an event payload once so fanout can reuse the same JSON string. */
export function serializeEventPayload(payload: unknown): SerializedEventPayload | null {
  if (payload === undefined) {
    return null;
  }
  const json = JSON.stringify(payload);
  return typeof json === "string" ? { json, [SERIALIZED_EVENT_PAYLOAD]: true } : null;
}

/** Narrow values created by serializeEventPayload. */
function isSerializedEventPayload(value: unknown): value is SerializedEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SERIALIZED_EVENT_PAYLOAD]?: unknown })[SERIALIZED_EVENT_PAYLOAD] === true &&
    typeof (value as { json?: unknown }).json === "string"
  );
}

/** Registry of currently connected Gateway nodes. */
export class NodeRegistry {
  private nodesById = new Map<string, PairingBoundNodeSession>();
  private nodesByConn = new Map<string, string>();
  private eventTransportsByConn = new Map<string, NodeEventTransport>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private invokeStreams = new NodeInvokeStreamController({
    pendingInvokes: this.pendingInvokes,
    sendCancel: (requestId, pending) => {
      const node = this.nodesById.get(pending.nodeId);
      // Older nodes only negotiated streamed cancellation. The authenticated
      // first-party host also aborts ordinary shell, MCP, and inference calls.
      if (
        !node ||
        node.connId !== pending.connId ||
        (!pending.onProgress &&
          (!isNodeWorkerHostClientId(node.clientId) || node.clientMode !== "node"))
      ) {
        return;
      }
      this.sendEventToSession(node, "node.invoke.cancel", {
        invokeId: requestId,
        nodeId: pending.nodeId,
      });
    },
    isConnectionActive: (pending) => {
      const node = this.nodesById.get(pending.nodeId);
      return isNodeRegistryPendingInvokeConnectionActive({
        registry: this,
        pending,
        currentNode: node,
      });
    },
    isCommandAllowed: (nodeId, command) => this.isCommandAllowed(nodeId, command),
    sendInput: (invokeId, pending, seq, payloadJSON) => {
      const node = this.nodesById.get(pending.nodeId);
      return node
        ? this.sendEventToSession(node, "node.invoke.input", {
            id: invokeId,
            nodeId: pending.nodeId,
            seq,
            payloadJSON,
          })
        : false;
    },
    onFailedResult: (pending) => {
      if (pending.systemRunEvent) {
        this.forgetAuthorizedSystemRunEvent({
          nodeId: pending.nodeId,
          connId: pending.connId,
          ...pending.systemRunEvent,
        });
      }
    },
    disconnectPending: (pending) => {
      if (pending.command === NODE_MCP_TOOLS_CALL_COMMAND) {
        pending.resolve({
          ok: false,
          error: {
            code: "MCP_SERVER_UNAVAILABLE",
            message: "node host disconnected during MCP tool call",
          },
        });
      } else {
        pending.resolve({
          ok: false,
          error: {
            code: "DISCONNECTED",
            message: `node disconnected (${pending.command})`,
          },
        });
      }
    },
  });
  private authorizedSystemRunEvents = new Map<string, AuthorizedSystemRunEvent>();
  private pairingGenerationEventChains = new Map<string, Promise<void>>();
  private committedConfig: OpenClawConfig | undefined;

  constructor(private readonly options: NodeRegistryOptions = {}) {
    this.committedConfig = options.getConfig?.();
    registerNodeRegistryPrivateRuntime(this, {
      getNode: (nodeId) => this.nodesById.get(nodeId),
      isCommandAllowed: (nodeId, command) =>
        this.isCommandAllowed(nodeId, command, this.options.getConfig?.()),
      listCurrentConnected: () => this.listCurrentConnected(),
      hasCurrentPairingStateResolver: Boolean(this.options.resolveCurrentPairingState),
      resolvePairingLease: async (node) => {
        const current = this.nodesById.get(node.nodeId);
        if (
          !current ||
          current.connId !== node.connId ||
          current.pairingIdentity !== node.pairingIdentity ||
          current.pairingGeneration !== node.pairingGeneration
        ) {
          return { status: "stale", presenceInvalidated: false };
        }
        return await this.resolvePairingLease(this.capturePairingLease(current), {
          invalidateStale: false,
        });
      },
      pendingInvokes: this.pendingInvokes,
      invokeStreams: this.invokeStreams,
      sendEventToSession: (node, event, payload) => {
        const current = this.nodesById.get(node.nodeId);
        return current?.connId === node.connId
          ? this.sendEventToSession(current, event, payload)
          : false;
      },
      rememberAuthorizedSystemRunEvent: (event) => this.rememberAuthorizedSystemRunEvent(event),
      publishActiveNodeContext: () => this.publishActiveNodeContext(),
    });
  }

  private listConnectedSessions(): PairingBoundNodeSession[] {
    return [...this.nodesById.values()].filter((node) => node.client.invalidated !== true);
  }

  private capturePairingLease(node: PairingBoundNodeSession): PairingBoundNodeSessionLease {
    return {
      session: node,
      nodeId: node.nodeId,
      connId: node.connId,
      binding: pairingBindingForSession(node),
    };
  }

  private currentSessionForLease(
    lease: PairingBoundNodeSessionLease,
  ): PairingBoundNodeSession | undefined {
    const current = this.nodesById.get(lease.nodeId);
    return current === lease.session &&
      current.connId === lease.connId &&
      current.pairingIdentity === lease.binding.identity &&
      current.pairingGeneration === lease.binding.generation &&
      current.client.invalidated !== true
      ? current
      : undefined;
  }

  private settlePairingLease(params: {
    lease: PairingBoundNodeSessionLease;
    isCurrent: boolean;
    invalidateStale: boolean;
  }): PairingLeaseResolution {
    const current = this.currentSessionForLease(params.lease);
    if (!current) {
      return { status: "stale", presenceInvalidated: false };
    }
    if (params.isCurrent) {
      return { status: "current", session: current };
    }
    const presenceInvalidated = params.invalidateStale
      ? this.invalidateSessionForPairingChange(current)
      : false;
    return { status: "stale", presenceInvalidated };
  }

  private async resolvePairingLease(
    lease: PairingBoundNodeSessionLease,
    options: { invalidateStale: boolean },
  ): Promise<PairingLeaseResolution> {
    const resolveCurrentPairingState = this.options.resolveCurrentPairingState;
    if (!resolveCurrentPairingState) {
      const current = this.currentSessionForLease(lease);
      return current
        ? { status: "current", session: current }
        : { status: "stale", presenceInvalidated: false };
    }
    let currentPairingState: PairedDeviceNodeBindingSnapshot | undefined;
    try {
      currentPairingState = await resolveCurrentPairingState(lease.nodeId);
    } catch {
      return { status: "unavailable" };
    }
    return this.settlePairingLease({
      lease,
      isCurrent: pairingStateMatchesBinding(lease.binding, currentPairingState),
      invalidateStale: options.invalidateStale,
    });
  }

  private refreshSessionPolicy(node: NodeSession): void {
    const policy = expectDefined(NODE_SESSION_POLICIES.get(node), "registered node policy missing");
    const cfg = this.committedConfig;
    const allowlist = cfg
      ? resolveNodeCommandAllowlist(cfg, {
          ...node,
          caps: policy.approvedCaps,
          commands: policy.approvedCommands,
          approvedCommands: policy.approvedCommands,
        })
      : undefined;
    const declaredCommands = node.sessionCommandsCeiling ?? node.declaredCommands;
    node.commands = policy.approvedCommands.filter(
      (command) => declaredCommands.includes(command) && (!allowlist || allowlist.has(command)),
    );
    if (allowlist) {
      policy.withheldCommands = declaredCommands.filter((command) => !allowlist.has(command));
    }
    node.caps = retainFulfilledNodeCapabilities({
      caps: policy.approvedCaps,
      admittedCommands: node.commands,
      withheldCommands: policy.withheldCommands,
    });
    node.computerUse = resolveEffectiveComputerUseDescriptor({
      commands: node.commands,
      declared: node.declaredComputerUse,
    });
    Object.assign(node.client.connect, {
      commands: node.commands,
      caps: node.caps,
      computerUse: node.computerUse,
    });
    const normalized = normalizeNodePluginToolDescriptors({
      nodeId: node.nodeId,
      tools: node.declaredNodePluginTools,
      allowedCommands: node.commands,
      enabled: cfg?.gateway?.nodes?.pluginTools?.enabled,
      registeredDescriptors: createRegisteredNodePluginToolDescriptorMap(
        this.options.listRegisteredNodePluginToolCommands?.(),
      ),
    });
    node.nodePluginTools = normalized.map((entry) => entry.descriptor);
    replaceConnectedNodePluginTools({
      nodeId: node.nodeId,
      displayName: node.displayName,
      platform: node.platform,
      remoteIp: node.remoteIp,
      tools: normalized,
    });
    node.nodeSkills = cfg?.gateway?.nodes?.allowSkills === false ? [] : policy.skills;
    recordRemoteSkillNodeInfo(node);
    replaceRemoteNodeSkills({
      nodeId: node.nodeId,
      displayName: node.displayName,
      skills: node.nodeSkills,
    });
  }

  private isCommandAllowed(nodeId: string, command: string, liveConfig?: OpenClawConfig): boolean {
    // Pending work uses the committed surface; only new dispatches check liveConfig.
    // A speculative candidate must not revoke an existing stream. Worker commands
    // retain their private operational owner outside this public command surface.
    if (!this.committedConfig || isPrivateNodeInvokeCommand(command)) {
      return true;
    }
    const node = this.nodesById.get(nodeId);
    return Boolean(
      node?.commands.includes(command) &&
      (!liveConfig || resolveNodeCommandAllowlist(liveConfig, node).has(command)),
    );
  }

  refreshRuntimePolicy(config = this.committedConfig): NodeSession[] {
    // Plugin attachment can overlap speculative config publication. Only the
    // committed reload owner supplies a new config; other refreshes reuse it.
    this.committedConfig = config;
    const nodes = this.listConnected();
    for (const node of nodes) {
      this.refreshSessionPolicy(node);
    }
    this.invokeStreams.reconcileRuntimePolicy();
    return nodes;
  }

  /** Register a websocket client as the current connection for its node id. */
  register(client: GatewayWsClient, opts: NodeSessionRegistrationOptions) {
    return this.registerSession(client, opts);
  }

  /** Register a node whose events are delivered by an HTTP polling transport. */
  registerTransport(
    client: GatewayWsClient,
    opts: NodeSessionRegistrationOptions,
    transport: NodeEventTransport,
  ) {
    return this.registerSession(client, opts, transport);
  }

  private registerSession(
    client: GatewayWsClient,
    opts: NodeSessionRegistrationOptions,
    transport?: NodeEventTransport,
  ) {
    if (!opts.pairingIdentity) {
      throw new Error("node session registration requires pairing identity");
    }
    const connect = client.connect as NodeSessionConnectParams;
    const nodeId = connect.device?.id ?? connect.client.id;
    const previousSession = this.nodesById.get(nodeId);
    const previousPairingGeneration = previousSession?.pairingGeneration;
    const caps = connect.caps ?? [];
    const commands = connect.commands ?? [];
    const declaredCaps = connect.declaredCaps ?? caps;
    const declaredCommands = connect.declaredCommands ?? commands;
    const computerUse =
      connect.computerUse === undefined
        ? undefined
        : parseComputerUseCapabilityDescriptor(connect.computerUse);
    const declaredComputerUseValue = connect.declaredComputerUse;
    const declaredComputerUse =
      declaredComputerUseValue === undefined
        ? computerUse
        : parseComputerUseCapabilityDescriptor(declaredComputerUseValue);
    // Session ceilings preserve protocol compatibility across later pairing
    // approvals while declared* retains the durable approval surface.
    const sessionCapsCeiling = connect.sessionCapsCeiling ?? declaredCaps;
    const sessionCommandsCeiling = connect.sessionCommandsCeiling ?? declaredCommands;
    const declaredPermissions = connect.declaredPermissions ?? connect.permissions;
    const permissions = opts.approvedSurface
      ? intersectNodePermissionSurface({
          approved: opts.approvedSurface.permissions,
          declared: declaredPermissions,
        })
      : connect.permissions;
    connect.permissions = permissions;
    const pathEnv = connect.pathEnv;
    const declaredNodePluginTools: NodePluginToolDescriptor[] = [];
    const nodePluginTools: NodePluginToolDescriptor[] = [];
    const nodeSkills: NodeSkillDescriptor[] = [];
    const session: PairingBoundNodeSession = {
      nodeId,
      connId: client.connId,
      pairingIdentity: opts.pairingIdentity,
      ...(opts.pairingGeneration ? { pairingGeneration: opts.pairingGeneration } : {}),
      client,
      clientId: connect.client.id,
      clientMode: connect.client.mode,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: connect.coreVersion,
      uiVersion: connect.uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      declaredCaps,
      sessionCapsCeiling,
      caps,
      declaredCommands,
      sessionCommandsCeiling,
      commands,
      ...(declaredComputerUse ? { declaredComputerUse } : {}),
      ...(computerUse ? { computerUse } : {}),
      declaredNodePluginTools,
      nodePluginTools,
      nodeSkills,
      declaredPermissions,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    // Preserve the approved declaration independently of policy, so re-enabling
    // a command cannot invent approval or require this connection to republish.
    NODE_SESSION_POLICIES.set(session, {
      approvedCaps: (opts.approvedSurface?.caps ?? caps).filter((cap) =>
        sessionCapsCeiling.includes(cap),
      ),
      approvedCommands: (opts.approvedSurface?.commands ?? commands).filter((command) =>
        sessionCommandsCeiling.includes(command),
      ),
      skills: [],
      withheldCommands: connect.withheldCommands ?? [],
    });
    const replacesPresence = previousSession?.lastActiveAtMs !== undefined;
    forgetNodeRunnerInventory(this, client.connId);
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    if (previousSession && previousSession.connId !== client.connId) {
      // Install the replacement first so retiring its old invokes cannot
      // remove the new session or publish a false offline transition.
      this.unregister(previousSession.connId);
    }
    if (
      previousPairingGeneration &&
      session.pairingGeneration &&
      previousPairingGeneration !== session.pairingGeneration
    ) {
      this.options.onPairingGenerationChanged?.({
        nodeId,
        previousPairingGeneration,
        nextPairingGeneration: session.pairingGeneration,
        preserveSessionState: false,
      });
    }
    if (transport) {
      this.eventTransportsByConn.set(client.connId, transport);
    } else {
      this.eventTransportsByConn.delete(client.connId);
    }
    this.refreshSessionPolicy(session);
    if (replacesPresence) {
      this.publishActiveNodeContext();
    }
    reconcileNodeRunnerAvailability(this, nodeId);
    return session;
  }

  /** Unregister one connection and reject invokes tied to that connection. */
  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    this.eventTransportsByConn.delete(connId);
    forgetNodeRunnerInventory(this, connId);
    const unregistersCurrentNode = this.nodesById.get(nodeId)?.connId === connId;
    if (unregistersCurrentNode) {
      const hadPresence = this.nodesById.get(nodeId)?.lastActiveAtMs !== undefined;
      this.nodesById.delete(nodeId);
      removeConnectedNodePluginTools(nodeId);
      removeRemoteNodeSkills(nodeId);
      if (hadPresence) {
        this.publishActiveNodeContext();
      }
    }
    this.invokeStreams.handleDisconnect(connId);
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (event.connId === connId) {
        this.authorizedSystemRunEvents.delete(key);
      }
    }
    reconcileNodeRunnerAvailability(this, nodeId);
    return unregistersCurrentNode ? nodeId : null;
  }

  /** List connected node sessions. */
  listConnected(): NodeSession[] {
    return this.listConnectedSessions();
  }

  /** Filter connected sessions against an already-loaded pairing-state snapshot. */
  listConnectedForPairingStates(
    currentPairingStates: ReadonlyMap<string, PairedDeviceNodeBindingSnapshot>,
  ): NodeSession[] {
    return this.listConnectedSessions().filter((node) => {
      const current = currentPairingStates.get(node.nodeId);
      return pairingStateMatchesBinding(pairingBindingForSession(node), current);
    });
  }

  /** Reconcile connected sessions through the synchronous persistent-pairing owner. */
  listCurrentConnectedSync(): NodeSession[] {
    const isPairingStateCurrent = this.options.isPairingStateCurrent;
    if (!isPairingStateCurrent) {
      return this.listConnected();
    }
    const connected: NodeSession[] = [];
    let invalidatedPresence = false;
    for (const candidate of this.listConnectedSessions()) {
      const lease = this.capturePairingLease(candidate);
      let isCurrent: boolean;
      try {
        isCurrent = isPairingStateCurrent(candidate.nodeId, lease.binding);
      } catch {
        continue;
      }
      const resolution = this.settlePairingLease({
        lease,
        isCurrent,
        invalidateStale: true,
      });
      if (resolution.status === "current") {
        connected.push(resolution.session);
      } else if (resolution.status === "stale") {
        invalidatedPresence ||= resolution.presenceInvalidated;
      }
    }
    if (invalidatedPresence) {
      this.publishActiveNodeContext();
    }
    return connected;
  }

  /** Resolve persistent pairing state before projecting connected sessions. */
  async listCurrentConnected(): Promise<NodeSession[]> {
    const resolved = await Promise.all(
      this.listConnectedSessions().map((node) =>
        this.resolvePairingLease(this.capturePairingLease(node), { invalidateStale: true }),
      ),
    );
    const connected: NodeSession[] = [];
    let invalidatedPresence = false;
    for (const result of resolved) {
      if (result.status === "current") {
        connected.push(result.session);
      } else if (result.status === "stale") {
        invalidatedPresence ||= result.presenceInvalidated;
      }
    }
    if (invalidatedPresence) {
      this.publishActiveNodeContext();
    }
    return connected;
  }

  private invalidateSessionForPairingChange(
    node: NodeSession,
    reason = "device-pairing-changed",
  ): boolean {
    if (this.nodesById.get(node.nodeId) !== node || node.client.invalidated === true) {
      return false;
    }
    node.client.invalidated = true;
    node.client.invalidatedReason ??= reason;
    forgetNodeRunnerInventory(this, node.connId);
    removeConnectedNodePluginTools(node.nodeId);
    removeRemoteNodeSkills(node.nodeId);
    this.invokeStreams.handleDisconnect(node.connId);
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (event.connId === node.connId) {
        this.authorizedSystemRunEvents.delete(key);
      }
    }
    reconcileNodeRunnerAvailability(this, node.nodeId);
    this.options.onPairingInvalidated?.({ nodeId: node.nodeId, connId: node.connId });
    return node.lastActiveAtMs !== undefined;
  }

  /** Immediately retires one exact transport after its persisted pairing authority changes. */
  invalidateConnectionForPairingChange(connId: string, reason = "device-pairing-changed"): boolean {
    const nodeId = this.nodesByConn.get(connId);
    const node = nodeId ? this.nodesById.get(nodeId) : undefined;
    if (!node || node.connId !== connId) {
      return false;
    }
    const invalidatedPresence = this.invalidateSessionForPairingChange(node, reason);
    if (invalidatedPresence) {
      this.publishActiveNodeContext();
    }
    return node.client.invalidated === true;
  }

  /** Return a connected node session by node id. */
  get(nodeId: string): NodeSession | undefined {
    return this.getRegisteredSession(nodeId);
  }

  private getRegisteredSession(nodeId: string): PairingBoundNodeSession | undefined {
    const node = this.nodesById.get(nodeId);
    return node?.client.invalidated === true ? undefined : node;
  }

  /** Return only the session authenticated for the requested persistent pairing generation. */
  getForPairingGeneration(nodeId: string, pairingGeneration: string): NodeSession | undefined {
    return this.getRegisteredSessionForPairingGeneration(nodeId, pairingGeneration);
  }

  private getRegisteredSessionForPairingGeneration(
    nodeId: string,
    pairingGeneration: string,
  ): PairingBoundNodeSession | undefined {
    const node = this.getRegisteredSession(nodeId);
    // A mismatch alone does not reveal whether the session or the requesting
    // operation is stale, so lookup must not revoke either generation.
    return node?.pairingGeneration === pairingGeneration ? node : undefined;
  }

  /** Revalidates that one inbound node connection still owns its persisted pairing state. */
  async isConnectionCurrentPairingState(connId: string): Promise<boolean> {
    const nodeId = this.nodesByConn.get(connId);
    const initial = nodeId ? this.nodesById.get(nodeId) : undefined;
    if (
      !nodeId ||
      !initial ||
      initial.connId !== connId ||
      initial.client.invalidated === true ||
      !this.options.resolveCurrentPairingState
    ) {
      return false;
    }
    const resolution = await this.resolvePairingLease(this.capturePairingLease(initial), {
      invalidateStale: true,
    });
    if (resolution.status === "stale" && resolution.presenceInvalidated) {
      this.publishActiveNodeContext();
    }
    return resolution.status === "current";
  }

  /** Stores the latest resource snapshot for the exact authenticated node connection. */
  updateHostStats(params: {
    nodeId: string;
    connId?: string;
    stats: NodeHostStatsPayload;
    observedAtMs?: number;
  }): NodeHostStats | null {
    const node = this.getRegisteredSession(params.nodeId);
    if (!node || node.connId !== params.connId) {
      return null;
    }
    // Resource snapshots are operator-facing; publishing active-node context would churn prompts.
    node.hostStats = { ...params.stats, updatedAtMs: params.observedAtMs ?? Date.now() };
    return node.hostStats;
  }

  /** Updates recent input activity for the exact authenticated node connection. */
  updatePresenceActivity(params: {
    nodeId: string;
    connId?: string;
    idleSeconds: number;
    saturated?: boolean;
    observedAtMs?: number;
  }): NodeSession | null {
    const node = this.nodesById.get(params.nodeId);
    if (
      !node ||
      !params.connId ||
      node.connId !== params.connId ||
      node.permissions?.accessibility !== true
    ) {
      return null;
    }
    const observedAtMs = params.observedAtMs ?? Date.now();
    const lastActiveAtMs = Math.max(0, observedAtMs - params.idleSeconds * 1000);
    if (params.saturated !== true || node.lastActiveAtMs === undefined) {
      node.lastActiveAtMs = Math.max(node.lastActiveAtMs ?? 0, lastActiveAtMs);
    }
    node.presenceUpdatedAtMs = observedAtMs;
    this.publishActiveNodeContext();
    return node;
  }

  /** Clears recent input activity for the exact authenticated node connection. */
  clearPresenceActivity(params: { nodeId: string; connId?: string }): boolean | null {
    const node = this.nodesById.get(params.nodeId);
    if (!node || !params.connId || node.connId !== params.connId) {
      return null;
    }
    if (node.lastActiveAtMs === undefined && node.presenceUpdatedAtMs === undefined) {
      return false;
    }
    node.lastActiveAtMs = undefined;
    node.presenceUpdatedAtMs = undefined;
    this.publishActiveNodeContext();
    return true;
  }

  /** Returns the connected node with the freshest reported local input. */
  getActiveNode(
    connectedNodes: readonly NodeSession[] = this.listConnected(),
  ): NodeSession | undefined {
    let active: NodeSession | undefined;
    for (const node of connectedNodes) {
      if (node.lastActiveAtMs === undefined) {
        continue;
      }
      if (
        !active ||
        node.lastActiveAtMs > (active.lastActiveAtMs ?? 0) ||
        (node.lastActiveAtMs === active.lastActiveAtMs &&
          (node.presenceUpdatedAtMs ?? 0) > (active.presenceUpdatedAtMs ?? 0))
      ) {
        active = node;
      }
    }
    return active;
  }

  private publishActiveNodeContext(): void {
    const active = this.getActiveNode(this.listConnectedSessions()) as
      | PairingBoundNodeSession
      | undefined;
    const lease = active ? this.capturePairingLease(active) : undefined;
    setActiveNodeContext(
      active
        ? {
            nodeId: active.nodeId,
            ...(active.pairingGeneration ? { pairingGeneration: active.pairingGeneration } : {}),
          }
        : null,
      lease
        ? {
            isCurrent: () => {
              if (!this.currentSessionForLease(lease)) {
                return false;
              }
              return this.options.isPairingStateCurrent
                ? this.options.isPairingStateCurrent(lease.nodeId, lease.binding)
                : true;
            },
          }
        : undefined,
    );
  }

  /** Probe websocket liveness with ping/pong when the socket supports it. */
  async checkConnectivity(nodeId: string, timeoutMs = 2_000): Promise<NodeConnectivityResult> {
    const node = this.getRegisteredSession(nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    // A successful old transport must never certify a replacement node.
    const currentConnectionResult = (result: NodeConnectivityResult): NodeConnectivityResult =>
      this.nodesById.get(nodeId) === node && node.client.invalidated !== true
        ? result
        : {
            ok: false,
            error: {
              code: "NOT_CONNECTED",
              message: "node connection changed during connectivity probe",
            },
          };
    const eventTransport = this.eventTransportsByConn.get(node.connId);
    if (eventTransport) {
      const result = eventTransport.checkConnectivity
        ? await eventTransport.checkConnectivity(timeoutMs)
        : { ok: true as const };
      return currentConnectionResult(result);
    }
    const socket = node.client.socket as PingableSocket;
    if (!this.isNodeWebSocketOpen(node)) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node socket not open" },
      };
    }
    if (typeof socket.ping !== "function" || typeof socket.once !== "function") {
      return { ok: true };
    }

    const timeout = Math.max(1, Math.trunc(timeoutMs));
    return await new Promise<NodeConnectivityResult>((resolve) => {
      let settled = false;
      const cleanup = () => {
        socket.off?.("pong", onPong);
        socket.off?.("close", onClose);
        socket.off?.("error", onError);
        socket.removeListener?.("pong", onPong);
        socket.removeListener?.("close", onClose);
        socket.removeListener?.("error", onError);
      };
      const finish = (result: NodeConnectivityResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(currentConnectionResult(result));
      };
      const onPong = () => finish({ ok: true });
      const onClose = () =>
        finish({
          ok: false,
          error: { code: "NOT_CONNECTED", message: "node socket closed during connectivity probe" },
        });
      const onError = (err: unknown) =>
        finish({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message:
              err instanceof Error ? err.message : "node socket error during connectivity probe",
          },
        });
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: { code: "TIMEOUT", message: "node connectivity probe timed out" },
          }),
        timeout,
      );

      socket.once?.("pong", onPong);
      socket.once?.("close", onClose);
      socket.once?.("error", onError);
      try {
        socket.ping?.(undefined, false, (err?: Error) => {
          if (err) {
            finish({
              ok: false,
              error: { code: "UNAVAILABLE", message: err.message },
            });
          }
        });
      } catch (err) {
        finish({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: err instanceof Error ? err.message : "node ping failed",
          },
        });
      }
    });
  }

  updateNodePluginTools(
    nodeId: string,
    connId: string | undefined,
    tools: readonly NodePluginToolDescriptor[],
  ): NodeSession | null {
    const node = this.nodesById.get(nodeId);
    if (!node || node.connId !== connId || node.client.invalidated === true) {
      return null;
    }
    node.declaredNodePluginTools = [...tools];
    this.refreshSessionPolicy(node);
    return node;
  }

  updateNodeSkills(
    nodeId: string,
    connId: string | undefined,
    skills: readonly NodeSkillDescriptor[],
  ): NodeSession | null {
    const node = this.nodesById.get(nodeId);
    if (!node || node.connId !== connId || node.client.invalidated === true) {
      return null;
    }
    expectDefined(NODE_SESSION_POLICIES.get(node), "registered node policy missing").skills =
      normalizeNodeSkillDescriptors({
        nodeId,
        skills,
      });
    this.refreshSessionPolicy(node);
    return node;
  }
  updateSurface(
    nodeId: string,
    surface: {
      caps?: readonly string[];
      commands: readonly string[];
      permissions?: Record<string, boolean> | undefined;
    },
    generationTransition?: {
      expectedConnId: string;
      expectedPairingIdentity: string;
      expectedPairingGeneration?: string;
      nextPairingGeneration: string;
    },
  ): NodeSession | null {
    const node = this.nodesById.get(nodeId);
    if (
      !node ||
      node.client.invalidated === true ||
      (generationTransition !== undefined &&
        (node.connId !== generationTransition.expectedConnId ||
          node.pairingIdentity !== generationTransition.expectedPairingIdentity ||
          node.pairingGeneration !== generationTransition.expectedPairingGeneration))
    ) {
      return null;
    }

    // Runtime approvals can only narrow capabilities/commands/permissions declared at connect.
    const policy = expectDefined(NODE_SESSION_POLICIES.get(node), "registered node policy missing");
    const sessionCommandsCeiling = new Set(node.sessionCommandsCeiling ?? node.declaredCommands);
    policy.approvedCommands = surface.commands.filter((command) =>
      sessionCommandsCeiling.has(command),
    );

    if ("caps" in surface) {
      const sessionCapsCeiling = new Set(node.sessionCapsCeiling ?? node.declaredCaps);
      policy.approvedCaps = (surface.caps ?? []).filter((capability) =>
        sessionCapsCeiling.has(capability),
      );
    }
    this.refreshSessionPolicy(node);

    if ("permissions" in surface) {
      node.permissions =
        surface.permissions === undefined
          ? undefined
          : intersectNodePermissionSurface({
              approved: surface.permissions,
              declared: node.declaredPermissions,
            });
      node.client.connect.permissions = node.permissions;
      this.clearPresenceIfAccessibilityUnavailable(node);
    }

    if (generationTransition) {
      const previousPairingGeneration = node.pairingGeneration;
      node.pairingGeneration = generationTransition.nextPairingGeneration;
      // Runner declarations are pairing-generation facts. Retire the old
      // declaration so the live process must publish for its promoted generation.
      settleNodeRegistryPairingGenerationChange({
        registry: this,
        nodeId,
        connId: node.connId,
        nextPairingGeneration: generationTransition.nextPairingGeneration,
      });
      reconcileNodeRunnerAvailability(this, nodeId);
      if (previousPairingGeneration) {
        this.options.onPairingGenerationChanged?.({
          nodeId,
          previousPairingGeneration,
          nextPairingGeneration: generationTransition.nextPairingGeneration,
          preserveSessionState: true,
        });
      }
      // Active-node leases capture the pairing generation, so a promoted live
      // session must republish its lease even when its presence is unchanged.
      this.publishActiveNodeContext();
    }

    return node;
  }

  private clearPresenceIfAccessibilityUnavailable(node: NodeSession): void {
    if (node.permissions?.accessibility === true || node.lastActiveAtMs === undefined) {
      return;
    }
    node.lastActiveAtMs = undefined;
    node.presenceUpdatedAtMs = undefined;
    this.publishActiveNodeContext();
  }

  async invoke(params: {
    nodeId: string;
    expectedConnId?: string;
    expectedPairingGeneration?: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    /** Inactivity deadline reset by each ordered progress chunk. */
    idleTimeoutMs?: number;
    onProgress?: (chunk: string) => void;
    signal?: AbortSignal;
    idempotencyKey?: string;
    sessionKey?: string;
    /** Receives the id and armed hard deadline after a successful dispatch. */
    onDispatchReady?: (invokeId: string, deadlineAtMs?: number) => void;
    /** Revalidates caller authority at the registry-owned transport handoff. */
    isDispatchAuthorized?: () => boolean;
  }): Promise<NodeInvokeResult> {
    return await invokePublicNodeRegistry(this, params);
  }

  /** Internal cleanup retains its owner through replies without admitting new root work. */
  invokeLifecycle(
    params: Parameters<NodeRegistry["invoke"]>[0] & { isDispatchAuthorized: () => boolean },
  ): Promise<NodeInvokeResult> {
    return invokeLifecycleNodeRegistry(this, params);
  }

  /** Send one ordered input frame to a pending streaming invoke. */
  sendInvokeInput(invokeId: string, payload: unknown): void {
    this.invokeStreams.sendInput(invokeId, payload);
  }

  /** Synchronous effect fence for callbacks retained across awaited host work. */
  isInvokeCurrent(invokeId: string, nodeId: string, connId: string): boolean {
    return this.invokeStreams.isPending(invokeId, nodeId, connId);
  }

  handleInvokeProgress(params: NodeInvokeProgressParams): boolean {
    return this.invokeStreams.handleProgress(params);
  }

  /** Continues only the exact live owner of a pending node invocation. */
  runPendingInvokeContinuation<T>(params: {
    invokeId: string;
    nodeId: string;
    connId: string | undefined;
    run: () => Promise<T>;
  }): Promise<T> | null {
    return this.invokeStreams.runPendingContinuation(params);
  }

  /** Authorize an inbound system.run event against a recently issued node invoke. */
  authorizeSystemRunEvent(params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
  }): boolean {
    if (!params.connId || !params.sessionKey) {
      return false;
    }
    const connId = params.connId;
    this.pruneAuthorizedSystemRunEvents();
    let match: { key: string; event: AuthorizedSystemRunEvent } | null;
    if (params.runId) {
      match = this.matchAuthorizedSystemRunEvent({
        nodeId: params.nodeId,
        connId,
        runId: params.runId,
        sessionKey: params.sessionKey,
      });
      if (!match && this.allowsLegacyMacRunIdFallback({ nodeId: params.nodeId, connId })) {
        match = this.matchSingleAuthorizedSystemRunEvent({
          nodeId: params.nodeId,
          connId,
          sessionKey: params.sessionKey,
        });
      }
    } else {
      if (!this.allowsLegacyMacRunIdFallback({ nodeId: params.nodeId, connId })) {
        return false;
      }
      match = this.matchSingleAuthorizedSystemRunEvent({
        nodeId: params.nodeId,
        connId,
        sessionKey: params.sessionKey,
      });
    }
    if (!match) {
      return false;
    }
    if (params.terminal) {
      this.authorizedSystemRunEvents.delete(match.key);
    }
    return true;
  }

  private rememberAuthorizedSystemRunEvent(
    event: Omit<AuthorizedSystemRunEvent, "expiresAtMs">,
  ): void {
    this.pruneAuthorizedSystemRunEvents();
    const authorized: AuthorizedSystemRunEvent = {
      ...event,
      expiresAtMs: this.authorizedSystemRunEventExpiresAt(event.timeoutMs),
    };
    this.authorizedSystemRunEvents.set(this.authorizedSystemRunEventKey(authorized), authorized);
  }

  private forgetAuthorizedSystemRunEvent(
    event: Omit<AuthorizedSystemRunEvent, "expiresAtMs">,
  ): void {
    this.authorizedSystemRunEvents.delete(this.authorizedSystemRunEventKey(event));
  }

  private authorizedSystemRunEventExpiresAt(timeoutMs: number | null | undefined): number | null {
    if (typeof timeoutMs !== "number") {
      return null;
    }
    const durationMs = addTimerTimeoutGraceMs(timeoutMs, AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS);
    return resolveExpiresAtMsFromDurationMs(durationMs) ?? 0;
  }

  private matchAuthorizedSystemRunEvent(params: {
    nodeId: string;
    connId: string;
    runId: string;
    sessionKey: string;
  }): { key: string; event: AuthorizedSystemRunEvent } | null {
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (
        event.nodeId === params.nodeId &&
        event.connId === params.connId &&
        event.runId === params.runId &&
        this.authorizedSystemRunSessionMatches(event, params.sessionKey)
      ) {
        return { key, event };
      }
    }
    return null;
  }

  private matchSingleAuthorizedSystemRunEvent(params: {
    nodeId: string;
    connId: string;
    sessionKey: string;
  }): { key: string; event: AuthorizedSystemRunEvent } | null {
    let match: { key: string; event: AuthorizedSystemRunEvent } | null = null;
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (
        event.nodeId !== params.nodeId ||
        event.connId !== params.connId ||
        !this.authorizedSystemRunSessionMatches(event, params.sessionKey)
      ) {
        continue;
      }
      if (match) {
        return null;
      }
      match = { key, event };
    }
    return match;
  }

  private authorizedSystemRunSessionMatches(
    event: AuthorizedSystemRunEvent,
    sessionKey: string,
  ): boolean {
    return !event.sessionKey || event.sessionKey === sessionKey;
  }

  private allowsLegacyMacRunIdFallback(params: { nodeId: string; connId: string }): boolean {
    const node = this.nodesById.get(params.nodeId);
    return (
      node?.connId === params.connId &&
      node.clientId === "openclaw-macos" &&
      node.platform === "darwin"
    );
  }

  private pruneAuthorizedSystemRunEvents(now = Date.now()): void {
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (
        event.expiresAtMs !== null &&
        !isFutureDateTimestampMs(event.expiresAtMs, { nowMs: now })
      ) {
        this.authorizedSystemRunEvents.delete(key);
      }
    }
  }

  private authorizedSystemRunEventKey(params: {
    nodeId: string;
    connId: string;
    runId: string;
    sessionKey?: string;
  }): string {
    return `${params.nodeId}\0${params.connId}\0${params.sessionKey ?? ""}\0${params.runId}`;
  }

  handleInvokeResult(params: NodeInvokeResultParams): boolean {
    return this.invokeStreams.handleResult(params);
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.sendEventToSession(node, event, payload);
  }

  sendEventRaw(
    nodeId: string,
    event: string,
    payloadJSON?: SerializedEventPayload | null,
  ): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.observeEventSend(node, event, this.sendEventRawInternal(node, event, payloadJSON));
  }

  /** Sends command-free events only to the exact authenticated pairing connection. */
  async sendEventForPairingIdentity(params: {
    nodeId: string;
    connId: string;
    pairingIdentity: string;
    event: string;
    payload?: unknown;
  }): Promise<boolean> {
    const initial = this.nodesById.get(params.nodeId);
    if (
      !initial ||
      initial.connId !== params.connId ||
      initial.pairingIdentity !== params.pairingIdentity ||
      initial.client.invalidated === true ||
      !this.options.resolveCurrentPairingState
    ) {
      return false;
    }
    const resolution = await this.resolvePairingLease(this.capturePairingLease(initial), {
      invalidateStale: true,
    });
    if (resolution.status !== "current") {
      if (resolution.status === "stale" && resolution.presenceInvalidated) {
        this.publishActiveNodeContext();
      }
      return false;
    }
    return this.sendEventToSession(resolution.session, params.event, params.payload);
  }

  /** Sends only to a session that still owns the requested persistent pairing generation. */
  async sendEventRawForPairingGeneration(
    nodeId: string,
    pairingGeneration: string,
    event: string,
    payloadJSON?: SerializedEventPayload | null,
  ): Promise<boolean> {
    const previous = this.pairingGenerationEventChains.get(nodeId) ?? Promise.resolve();
    const send = previous.then(() =>
      this.sendEventRawForPairingGenerationNow(nodeId, pairingGeneration, event, payloadJSON),
    );
    const tail = send.then(
      () => undefined,
      () => undefined,
    );
    this.pairingGenerationEventChains.set(nodeId, tail);
    try {
      return await send;
    } finally {
      if (this.pairingGenerationEventChains.get(nodeId) === tail) {
        this.pairingGenerationEventChains.delete(nodeId);
      }
    }
  }

  private async sendEventRawForPairingGenerationNow(
    nodeId: string,
    pairingGeneration: string,
    event: string,
    payloadJSON?: SerializedEventPayload | null,
  ): Promise<boolean> {
    let node = this.getRegisteredSessionForPairingGeneration(nodeId, pairingGeneration);
    if (!node) {
      return false;
    }
    if (this.options.resolveCurrentPairingState) {
      const resolution = await this.resolvePairingLease(this.capturePairingLease(node), {
        invalidateStale: true,
      });
      if (resolution.status !== "current") {
        if (resolution.status === "stale" && resolution.presenceInvalidated) {
          this.publishActiveNodeContext();
        }
        return false;
      }
      node = resolution.session;
    }
    return this.observeEventSend(node, event, this.sendEventRawInternal(node, event, payloadJSON));
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    if (node.client.invalidated === true) {
      return false;
    }
    const eventTransport = this.eventTransportsByConn.get(node.connId);
    if (eventTransport) {
      return eventTransport.send(event, payload);
    }
    if (!this.isNodeWebSocketOpen(node)) {
      return false;
    }
    if (this.rejectSlowNodeSocket(node)) {
      return false;
    }
    try {
      node.client.socket.send(serializeNodeEvent(event, payload));
      return true;
    } catch {
      return false;
    }
  }

  private sendEventRawInternal(
    node: NodeSession,
    event: string,
    payloadJSON?: SerializedEventPayload | null,
  ): boolean {
    if (node.client.invalidated === true) {
      return false;
    }
    if (
      payloadJSON !== null &&
      payloadJSON !== undefined &&
      !isSerializedEventPayload(payloadJSON)
    ) {
      return false;
    }
    const eventTransport = this.eventTransportsByConn.get(node.connId);
    if (eventTransport) {
      return eventTransport.sendRaw(event, payloadJSON);
    }
    if (!this.isNodeWebSocketOpen(node)) {
      return false;
    }
    if (this.rejectSlowNodeSocket(node)) {
      return false;
    }
    try {
      const payloadFragment = payloadJSON ? `,"payload":${payloadJSON.json}` : "";
      node.client.socket.send(
        `{"type":"event","event":${JSON.stringify(event)}${payloadFragment}}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.observeEventSend(node, event, this.sendEventInternal(node, event, payload));
  }

  private observeEventSend(node: NodeSession, event: string, sent: boolean): boolean {
    if (sent || this.nodesById.get(node.nodeId) !== node || node.client.invalidated === true) {
      return sent;
    }
    const now = Date.now();
    const lastLoggedAt = failedEventLogAtByNode.get(node);
    if (lastLoggedAt === undefined || now - lastLoggedAt >= FAILED_EVENT_LOG_INTERVAL_MS) {
      failedEventLogAtByNode.set(node, now);
      log.warn("node event delivery failed", { nodeId: node.nodeId, event });
    }
    return sent;
  }

  private isNodeWebSocketOpen(node: NodeSession): boolean {
    // ws.send() does not throw after entering CLOSING; it only accounts the
    // unsent bytes. Keep the synchronous send-admission result truthful.
    return node.client.socket.readyState === WEBSOCKET_OPEN_READY_STATE;
  }

  private rejectSlowNodeSocket(node: NodeSession): boolean {
    if (!(node.client.socket.bufferedAmount > MAX_BUFFERED_BYTES)) {
      return false;
    }
    logRejectedLargePayload({
      surface: "gateway.ws.outbound_buffer",
      bytes: node.client.socket.bufferedAmount,
      limitBytes: MAX_BUFFERED_BYTES,
      reason: "ws_send_buffer_close",
    });
    try {
      node.client.socket.close(SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
    } catch {
      /* ignore */
    }
    node.client.socket.terminate();
    return true;
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
