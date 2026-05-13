import { randomUUID } from "node:crypto";
import type { GatewayWsClient } from "./server/ws-types.js";

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
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

type PendingInvoke = {
  nodeId: string;
  connId: string;
  command: string;
  systemRunEvent?: PendingSystemRunEvent;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingSystemRunEvent = {
  runId: string;
  sessionKey?: string;
  timeoutMs?: number | null;
};

type AuthorizedSystemRunEvent = PendingSystemRunEvent & {
  nodeId: string;
  connId: string;
  expiresAtMs: number | null;
};

type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

const SERIALIZED_EVENT_PAYLOAD = Symbol("openclaw.serializedEventPayload");
const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;

export type SerializedEventPayload = {
  readonly json: string;
  readonly [SERIALIZED_EVENT_PAYLOAD]: true;
};

export function serializeEventPayload(payload: unknown): SerializedEventPayload | null {
  if (!payload) {
    return null;
  }
  const json = JSON.stringify(payload);
  return typeof json === "string" ? { json, [SERIALIZED_EVENT_PAYLOAD]: true } : null;
}

function isSerializedEventPayload(value: unknown): value is SerializedEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [SERIALIZED_EVENT_PAYLOAD]?: unknown })[SERIALIZED_EVENT_PAYLOAD] === true &&
    typeof (value as { json?: unknown }).json === "string"
  );
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSystemRunTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const timeoutMs = Math.trunc(value);
  return timeoutMs > 0 ? timeoutMs : null;
}

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

function withSystemRunEventRunId(params: { command: string; params?: unknown }): unknown {
  if (
    params.command !== "system.run" ||
    !params.params ||
    typeof params.params !== "object" ||
    Array.isArray(params.params)
  ) {
    return params.params;
  }
  const obj = params.params as Record<string, unknown>;
  if (normalizeString(obj.runId)) {
    return params.params;
  }
  return { ...obj, runId: randomUUID() };
}

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private authorizedSystemRunEvents = new Map<string, AuthorizedSystemRunEvent>();

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
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
      caps,
      commands,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    const unregistersCurrentNode = this.nodesById.get(nodeId)?.connId === connId;
    if (unregistersCurrentNode) {
      this.nodesById.delete(nodeId);
    }
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.connId !== connId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    for (const [key, event] of this.authorizedSystemRunEvents) {
      if (event.connId === connId) {
        this.authorizedSystemRunEvents.delete(key);
      }
    }
    return unregistersCurrentNode ? nodeId : null;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
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
    const requestId = randomUUID();
    const invokeParams = withSystemRunEventRunId({
      command: params.command,
      params: params.params,
    });
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && invokeParams !== undefined ? JSON.stringify(invokeParams) : null,
      timeoutMs: params.timeoutMs,
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
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        connId: node.connId,
        command: params.command,
        systemRunEvent,
        resolve,
        reject,
        timer,
      });
    });
  }

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
    let match: { key: string; event: AuthorizedSystemRunEvent } | null = null;
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
    return Date.now() + timeoutMs + AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS;
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
      if (event.expiresAtMs !== null && event.expiresAtMs <= now) {
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
    clearTimeout(pending.timer);
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
}
