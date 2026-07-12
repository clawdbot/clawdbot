// Gateway node registry.
// Tracks connected node clients, invoke requests, broadcasts, and system.run approvals.
import { randomUUID } from "node:crypto";
import {
  addTimerTimeoutGraceMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
// NodeSession is plugin-SDK-reachable; importing these types from the
// gateway-protocol index would retain the whole ProtocolSchemas registry in
// the public plugin-sdk dts (check-plugin-sdk-exports guards this).
import type {
  NodePluginToolDescriptor,
  NodeSkillDescriptor,
} from "../../packages/gateway-protocol/src/schema/nodes.js";
import { setActiveNodeContext } from "../infra/active-node-context.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import {
  createRegisteredNodePluginToolDescriptorMap,
  normalizeNodePluginToolDescriptors,
  type NormalizedNodePluginTool,
  removeConnectedNodePluginTools,
  replaceConnectedNodePluginTools,
  type RegisteredNodePluginToolCommand,
} from "./node-plugin-tool-snapshot.js";
import { normalizeNodeSkillDescriptors } from "./node-skill-descriptors.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

/** Connected node session advertised over Gateway websocket. */
export type NodeSession = {
  nodeId: string;
  connId: string;
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
  declaredNodePluginTools: NodePluginToolDescriptor[];
  nodePluginTools: NodePluginToolDescriptor[];
  nodeSkills: NodeSkillDescriptor[];
  declaredPermissions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
  lastActiveAtMs?: number;
  presenceUpdatedAtMs?: number;
};

/** Pending invoke awaiting a node.invoke.response. */
type PendingInvoke = {
  nodeId: string;
  connId: string;
  command: string;
  systemRunEvent?: PendingSystemRunEvent;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** system.run metadata remembered while waiting for node events. */
type PendingSystemRunEvent = {
  runId: string;
  sessionKey?: string;
  timeoutMs?: number | null;
};

/** Authorized system.run event window bound to one node connection. */
type AuthorizedSystemRunEvent = PendingSystemRunEvent & {
  nodeId: string;
  connId: string;
  expiresAtMs: number | null;
};

/** Result payload returned from node.invoke. */
type NodeInvokeResult = {
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
  readyState?: number;
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
const WEBSOCKET_OPEN_READY_STATE = 1;
const SLOW_CONSUMER_CLOSE_CODE = 1008;

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

export type NodeRegistryOptions = {
  listRegisteredNodePluginToolCommands?:
    | (() => readonly RegisteredNodePluginToolCommand[] | undefined)
    | undefined;
  nodePluginToolsEnabled?: boolean;
  nodeSkillsEnabled?: boolean;
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

/** Normalize optional string-ish websocket fields. */
function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize system.run timeout values, preserving null for no expiry. */
function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : null;
}

/** Extract system.run event auth metadata from invoke params. */
function resolvePendingSystemRunEvent(params: {
  command: string;
  params?: unknown;
}): PendingSystemRunEvent | undefined {
  if (params.command !== "system.run" || !params.params || typeof params.params !== "object") {
    return undefined;
  }
  const obj = params.params as Record<string, unknown>;
  const runId = normalizeString(obj.runId);
  if (!runId) {
    return undefined;
  }
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  const sessionKey = normalizeString(obj.sessionKey);
  return {
    runId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** Keep node execution and Gateway authorization on the same canonical system.run fields. */
function normalizeSystemRunInvokeParams(params: { command: string; params?: unknown }): unknown {
  if (
    params.command !== "system.run" ||
    !params.params ||
    typeof params.params !== "object" ||
    Array.isArray(params.params)
  ) {
    return params.params;
  }
  const obj = params.params as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...obj,
    runId: normalizeString(obj.runId) || randomUUID(),
  };
  const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
  if (timeoutMs === undefined) {
    delete normalized.timeoutMs;
  } else {
    normalized.timeoutMs = timeoutMs;
  }
  return normalized;
}

/** Registry of currently connected Gateway nodes. */
export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private eventTransportsByConn = new Map<string, NodeEventTransport>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private authorizedSystemRunEvents = new Map<string, AuthorizedSystemRunEvent>();

  constructor(private readonly options: NodeRegistryOptions = {}) {}

  private normalizePluginToolDescriptors(params: {
    nodeId: string;
    tools?: readonly NodePluginToolDescriptor[];
    allowedCommands: readonly string[];
  }): NormalizedNodePluginTool[] {
    return normalizeNodePluginToolDescriptors({
      ...params,
      enabled: this.options.nodePluginToolsEnabled,
      registeredDescriptors: createRegisteredNodePluginToolDescriptorMap(
        this.options.listRegisteredNodePluginToolCommands?.(),
      ),
    });
  }

  private replaceEffectiveNodePluginTools(node: NodeSession): void {
    const normalized = this.normalizePluginToolDescriptors({
      nodeId: node.nodeId,
      tools: node.declaredNodePluginTools,
      allowedCommands: node.commands,
    });
    node.nodePluginTools = normalized.map((entry) => entry.descriptor);
    replaceConnectedNodePluginTools({
      nodeId: node.nodeId,
      displayName: node.displayName,
      platform: node.platform,
      remoteIp: node.remoteIp,
      tools: normalized,
    });
  }

  refreshNodePluginTools(): void {
    for (const node of this.nodesById.values()) {
      this.replaceEffectiveNodePluginTools(node);
    }
  }

  /** Register a websocket client as the current connection for its node id. */
  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    return this.registerSession(client, opts);
  }

  /** Register a node whose events are delivered by an HTTP polling transport. */
  registerTransport(
    client: GatewayWsClient,
    opts: { remoteIp?: string | undefined },
    transport: NodeEventTransport,
  ) {
    return this.registerSession(client, opts, transport);
  }

  private registerSession(
    client: GatewayWsClient,
    opts: { remoteIp?: string | undefined },
    transport?: NodeEventTransport,
  ) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const declaredCaps = Array.isArray((connect as { declaredCaps?: string[] }).declaredCaps)
      ? ((connect as { declaredCaps?: string[] }).declaredCaps ?? [])
      : caps;
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const declaredCommands = Array.isArray(
      (connect as { declaredCommands?: string[] }).declaredCommands,
    )
      ? ((connect as { declaredCommands?: string[] }).declaredCommands ?? [])
      : commands;
    // Session ceilings preserve protocol compatibility across later pairing
    // approvals while declared* retains the durable approval surface.
    const sessionCapsCeiling = Array.isArray(
      (connect as { sessionCapsCeiling?: string[] }).sessionCapsCeiling,
    )
      ? ((connect as { sessionCapsCeiling?: string[] }).sessionCapsCeiling ?? [])
      : declaredCaps;
    const sessionCommandsCeiling = Array.isArray(
      (connect as { sessionCommandsCeiling?: string[] }).sessionCommandsCeiling,
    )
      ? ((connect as { sessionCommandsCeiling?: string[] }).sessionCommandsCeiling ?? [])
      : declaredCommands;
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const declaredPermissions =
      typeof (connect as { declaredPermissions?: Record<string, boolean> }).declaredPermissions ===
      "object"
        ? ((connect as { declaredPermissions?: Record<string, boolean> }).declaredPermissions ??
          undefined)
        : permissions;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const declaredNodePluginTools: NodePluginToolDescriptor[] = [];
    const nodePluginTools: NodePluginToolDescriptor[] = [];
    const nodeSkills: NodeSkillDescriptor[] = [];
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
      clientId: connect.client.id,
      clientMode: connect.client.mode,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      declaredCaps,
      sessionCapsCeiling,
      caps,
      declaredCommands,
      sessionCommandsCeiling,
      commands,
      declaredNodePluginTools,
      nodePluginTools,
      nodeSkills,
      declaredPermissions,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    const replacesPresence = this.nodesById.get(nodeId)?.lastActiveAtMs !== undefined;
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    if (transport) {
      this.eventTransportsByConn.set(client.connId, transport);
    } else {
      this.eventTransportsByConn.delete(client.connId);
    }
    replaceConnectedNodePluginTools({
      nodeId,
      displayName: session.displayName,
      platform: session.platform,
      remoteIp: session.remoteIp,
      tools: [],
    });
    if (replacesPresence) {
      this.publishActiveNodeContext();
    }
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
    const unregistersCurrentNode = this.nodesById.get(nodeId)?.connId === connId;
    if (unregistersCurrentNode) {
      const hadPresence = this.nodesById.get(nodeId)?.lastActiveAtMs !== undefined;
      this.nodesById.delete(nodeId);
      removeConnectedNodePluginTools(nodeId);
      if (hadPresence) {
        this.publishActiveNodeContext();
      }
    }
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.connId !== connId) {
        continue;
      }
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      if (pending.command === NODE_MCP_TOOLS_CALL_COMMAND) {
        // Preserve MCP's structured failure contract when transport loss wins
        // the race; callers can degrade instead of seeing an opaque invoke error.
        pending.resolve({
          ok: false,
          error: {
            code: "MCP_SERVER_UNAVAILABLE",
            message: "node host disconnected during MCP tool call",
          },
        });
      } else {
        pending.reject(new Error(`node disconnected (${pending.command})`));
      }
      this.pendingInvokes.delete(id);
    }
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (event.connId === connId) {
        this.authorizedSystemRunEvents.delete(key);
      }
    }
    return unregistersCurrentNode ? nodeId : null;
  }

  /** List connected node sessions. */
  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  /** Return a connected node session by node id. */
  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
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

  /** Returns the connected node with the freshest reported local input. */
  getActiveNode(): NodeSession | undefined {
    let active: NodeSession | undefined;
    for (const node of this.nodesById.values()) {
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
    const active = this.getActiveNode();
    setActiveNodeContext(active ? { nodeId: active.nodeId } : null);
  }

  /** Probe websocket liveness with ping/pong when the socket supports it. */
  async checkConnectivity(nodeId: string, timeoutMs = 2_000): Promise<NodeConnectivityResult> {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const eventTransport = this.eventTransportsByConn.get(node.connId);
    if (eventTransport) {
      return eventTransport.checkConnectivity?.(timeoutMs) ?? { ok: true };
    }
    const socket = node.client.socket as PingableSocket;
    if (socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
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
        resolve(result);
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
    if (!node || node.connId !== connId) {
      return null;
    }
    node.declaredNodePluginTools = this.options.nodePluginToolsEnabled === false ? [] : [...tools];
    this.replaceEffectiveNodePluginTools(node);
    return node;
  }

  updateNodeSkills(
    nodeId: string,
    connId: string | undefined,
    skills: readonly NodeSkillDescriptor[],
  ): NodeSession | null {
    const node = this.nodesById.get(nodeId);
    if (!node || node.connId !== connId) {
      return null;
    }
    node.nodeSkills = normalizeNodeSkillDescriptors({
      nodeId,
      skills,
      enabled: this.options.nodeSkillsEnabled,
    });
    return node;
  }
  updateSurface(
    nodeId: string,
    surface: {
      caps?: readonly string[];
      commands: readonly string[];
      permissions?: Record<string, boolean> | undefined;
    },
  ): NodeSession | null {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return null;
    }

    // Runtime approvals can only narrow capabilities/commands/permissions declared at connect.
    const sessionCommandsCeiling = new Set(node.sessionCommandsCeiling ?? node.declaredCommands);
    const nextCommands = surface.commands.filter((command) => sessionCommandsCeiling.has(command));
    node.commands = nextCommands;
    (node.client.connect as { commands?: string[] }).commands = nextCommands;
    this.replaceEffectiveNodePluginTools(node);

    if ("caps" in surface) {
      const sessionCapsCeiling = new Set(node.sessionCapsCeiling ?? node.declaredCaps);
      const nextCaps = (surface.caps ?? []).filter((capability) =>
        sessionCapsCeiling.has(capability),
      );
      node.caps = nextCaps;
      (node.client.connect as { caps?: string[] }).caps = nextCaps;
    }

    if ("permissions" in surface) {
      if (surface.permissions === undefined) {
        node.permissions = undefined;
        (node.client.connect as { permissions?: Record<string, boolean> }).permissions = undefined;
        this.clearPresenceIfAccessibilityUnavailable(node);
        return node;
      }
      const declared = node.declaredPermissions ?? {};
      const nextEntries: Array<[string, boolean]> = [];
      for (const [key, declaredValue] of Object.entries(declared)) {
        if (!declaredValue) {
          nextEntries.push([key, false]);
          continue;
        }
        const approvedValue = surface.permissions?.[key];
        if (approvedValue) {
          nextEntries.push([key, true]);
          continue;
        }
        if (approvedValue !== undefined) {
          nextEntries.push([key, false]);
        }
      }
      const nextPermissions = nextEntries.length > 0 ? Object.fromEntries(nextEntries) : undefined;
      node.permissions = nextPermissions;
      (node.client.connect as { permissions?: Record<string, boolean> }).permissions =
        nextPermissions;
      this.clearPresenceIfAccessibilityUnavailable(node);
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
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    if (params.expectedConnId && node.connId !== params.expectedConnId) {
      return {
        ok: false,
        error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
      };
    }
    const requestId = randomUUID();
    const invokeParams = normalizeSystemRunInvokeParams({
      command: params.command,
      params: params.params,
    });
    // Keep node and Gateway on the same timer-safe value; zero disables both deadlines.
    const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 30_000, 0);
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && invokeParams !== undefined ? JSON.stringify(invokeParams) : null,
      timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const ok = this.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      };
    }
    const systemRunEvent = resolvePendingSystemRunEvent({
      command: params.command,
      params: invokeParams,
    });
    if (systemRunEvent) {
      this.rememberAuthorizedSystemRunEvent({
        nodeId: params.nodeId,
        connId: node.connId,
        ...systemRunEvent,
      });
    }
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingInvokes.delete(requestId);
              resolve({
                ok: false,
                error: { code: "TIMEOUT", message: "node invoke timed out" },
              });
            }, timeoutMs)
          : undefined;
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        connId: node.connId,
        command: params.command,
        systemRunEvent,
        resolve,
        reject,
        ...(timer !== undefined ? { timer } : {}),
      });
    });
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

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    connId: string | undefined;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId || pending.connId !== params.connId) {
      return false;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    this.pendingInvokes.delete(params.id);
    if (!params.ok && pending.systemRunEvent) {
      this.forgetAuthorizedSystemRunEvent({
        nodeId: pending.nodeId,
        connId: pending.connId,
        ...pending.systemRunEvent,
      });
    }
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
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
    return this.sendEventRawInternal(node, event, payloadJSON);
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    const eventTransport = this.eventTransportsByConn.get(node.connId);
    if (eventTransport) {
      return eventTransport.send(event, payload);
    }
    if (this.rejectSlowNodeSocket(node)) {
      return false;
    }
    try {
      node.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
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
    return this.sendEventInternal(node, event, payload);
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
    return true;
  }
}
