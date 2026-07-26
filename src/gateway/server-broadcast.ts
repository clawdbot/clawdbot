import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
// Gateway WebSocket broadcaster.
// Applies event scope guards and slow-consumer handling before sending frames.
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { isBrowserCopilotClient } from "../utils/message-channel.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
} from "./method-scopes.js";
import type {
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastToConnIdsFn,
  GatewayBufferedAmountFn,
  GatewayPluginEventBroadcastFn,
  GatewayPluginEventScope,
} from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

// Pairing scope is for device-pairing handshakes only; chat transcript events
// require operator-level session access. Pairing-scoped and node-role clients
// must not passively receive chat-class broadcasts.
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [READ_SCOPE],
  chat: [READ_SCOPE],
  "board.changed": [READ_SCOPE],
  "board.command": [READ_SCOPE],
  "ui.command": [READ_SCOPE],
  "chat.send_timing": [READ_SCOPE],
  "chat.side_result": [READ_SCOPE],
  cron: [READ_SCOPE],
  health: [],
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "question.requested": [QUESTIONS_SCOPE],
  "question.resolved": [QUESTIONS_SCOPE],
  heartbeat: [],
  "plugin.approval.requested": [APPROVALS_SCOPE],
  "plugin.approval.resolved": [APPROVALS_SCOPE],
  "openclaw.approval.requested": [APPROVALS_SCOPE],
  "openclaw.approval.resolved": [APPROVALS_SCOPE],
  presence: [],
  shutdown: [],
  tick: [],
  "talk.event": [READ_SCOPE],
  "talk.mode": [WRITE_SCOPE],
  task: [READ_SCOPE],
  "task.suggestion": [READ_SCOPE],
  "update.available": [],
  // Hash-only change notice after a persisted config write; content stays
  // behind the operator-scoped config.get.
  "config.changed": [READ_SCOPE],
  "voicewake.changed": [READ_SCOPE],
  "voicewake.routing.changed": [READ_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  "node.presence": [READ_SCOPE],
  "sessions.catalog.host": [READ_SCOPE],
  "sessions.changed": [READ_SCOPE],
  "session.approval": [APPROVALS_SCOPE],
  "session.message": [READ_SCOPE],
  "session.observer": [READ_SCOPE],
  "session.operation": [READ_SCOPE],
  "session.sharing": [READ_SCOPE],
  "session.suggestion": [READ_SCOPE],
  "session.typing": [READ_SCOPE],
  "session.tool": [READ_SCOPE],
  // Operator terminal byte/exit streams. Admin-gated to match the terminal.*
  // methods; also targeted to the owning connection at broadcast time.
  "terminal.data": [ADMIN_SCOPE],
  "terminal.exit": [ADMIN_SCOPE],
};

// Opt-in scoped clients never receive session-bearing broadcasts without an
// authoritative registry key, including malformed/sessionless agent events.
const SESSION_SUBSCRIPTION_EVENTS = new Set([
  "agent",
  "chat",
  "chat.side_result",
  "session.observer",
]);

function serializeFrameField(name: "payload" | "stateVersion", value: unknown): string {
  // Serialize one field through JSON.stringify so embedded values keep JSON
  // escaping, then splice it into the shared per-client frame body.
  const fieldJSON = JSON.stringify({ [name]: value });
  const keyJSON = JSON.stringify(name);
  const prefix = `{${keyJSON}:`;
  return fieldJSON.startsWith(prefix) ? `,${keyJSON}:${fieldJSON.slice(prefix.length, -1)}` : "";
}

function resolveBroadcastSessionScope(
  payload: unknown,
  explicit: readonly string[] | undefined,
  explicitAgentId: string | undefined,
): { sessionKeys: readonly string[]; agentId?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      sessionKeys: explicit ?? [],
      ...(explicitAgentId ? { agentId: explicitAgentId } : {}),
    };
  }
  const record = payload as {
    sessionKey?: unknown;
    agentId?: unknown;
    suggestion?: { sessionKey?: unknown; agentId?: unknown };
    request?: { sessionKey?: unknown; agentId?: unknown };
  };
  const source = [record, record.suggestion, record.request].find(
    (candidate) => typeof candidate?.sessionKey === "string" && candidate.sessionKey.trim(),
  );
  const sessionKey = typeof source?.sessionKey === "string" ? source.sessionKey.trim() : "";
  const agentId =
    explicitAgentId ??
    (typeof source?.agentId === "string" ? source.agentId.trim() || undefined : undefined);
  return {
    sessionKeys: explicit?.length ? explicit : sessionKey ? [sessionKey] : [],
    ...(agentId ? { agentId } : {}),
  };
}

function hasEventScope(
  client: GatewayWsClient,
  event: string,
  explicitPluginScope?: GatewayPluginEventScope,
): boolean {
  if (client.connectionKind === "worker") {
    return false;
  }
  const role = client.connect.role ?? "operator";
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (explicitPluginScope) {
    if (role !== "operator") {
      return false;
    }
    if (scopes.includes(ADMIN_SCOPE)) {
      return true;
    }
    return explicitPluginScope === READ_SCOPE
      ? scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)
      : explicitPluginScope === WRITE_SCOPE && scopes.includes(WRITE_SCOPE);
  }
  const required = EVENT_SCOPE_GUARDS[event];
  // Plugin-defined gateway broadcast events (plugin.* namespace) are allowed
  // for operator.write and operator.admin scopes. Explicit plugin.* entries
  // in EVENT_SCOPE_GUARDS take precedence (e.g., plugin.approval.*).
  if (!required && event.startsWith("plugin.")) {
    if (role !== "operator") {
      return false;
    }
    return scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE);
  }
  if (!required) {
    return false;
  }
  if (required.length === 0) {
    return true;
  }
  if (role !== "operator") {
    return false;
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (required.includes(READ_SCOPE)) {
    return scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return required.some((scope) => scopes.includes(scope));
}

export function createGatewayBroadcaster(params: {
  clients: Set<GatewayWsClient>;
  sessionMessageSubscribers?: SessionMessageSubscriberRegistry;
  canReceiveSessionEvent?: (
    client: GatewayWsClient,
    sessionKeys: readonly string[],
    agentId?: string,
    event?: string,
    payload?: unknown,
  ) => boolean;
}) {
  const clientSeq = new WeakMap<GatewayWsClient, number>();
  const reportedSlowPayloadClients = new WeakSet<GatewayWsClient>();

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
    explicitPluginScope?: GatewayPluginEventScope,
  ) => {
    if (params.clients.size === 0) {
      return;
    }
    const { sessionKeys, agentId } = resolveBroadcastSessionScope(
      payload,
      opts?.sessionKeys,
      opts?.agentId,
    );
    const isTargeted = Boolean(targetConnIds);
    if (shouldLogWs()) {
      const logMeta: Record<string, unknown> = {
        event,
        seq: isTargeted ? "targeted" : "per-client",
        clients: params.clients.size,
        targets: targetConnIds ? targetConnIds.size : undefined,
        dropIfSlow: opts?.dropIfSlow,
        presenceVersion: opts?.stateVersion?.presence,
        healthVersion: opts?.stateVersion?.health,
      };
      if (event === "agent") {
        Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
      }
      logWs("out", "event", logMeta);
    }
    let frameBase:
      | {
          eventJSON: string;
          payloadFragment: string;
          stateVersionFragment: string;
        }
      | undefined;
    const getFrameBase = () => {
      if (!frameBase) {
        frameBase = {
          eventJSON: JSON.stringify(event),
          payloadFragment: serializeFrameField("payload", payload),
          stateVersionFragment:
            opts?.stateVersion === undefined
              ? ""
              : serializeFrameField("stateVersion", opts.stateVersion),
        };
      }
      return frameBase;
    };
    for (const c of params.clients) {
      if (c.invalidated === true) {
        continue;
      }
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      if (!hasEventScope(c, event, explicitPluginScope)) {
        continue;
      }
      if (
        sessionKeys.length > 0 &&
        params.canReceiveSessionEvent &&
        !params.canReceiveSessionEvent(c, sessionKeys, agentId, event, payload)
      ) {
        continue;
      }
      const requiresSessionSubscription =
        event === "session.typing" ||
        ((isBrowserCopilotClient(c.connect.client) ||
          hasGatewayClientCap(c.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)) &&
          SESSION_SUBSCRIPTION_EVENTS.has(event));
      if (
        requiresSessionSubscription &&
        (!opts?.sessionKeys?.length ||
          !opts.sessionKeys.some((sessionKey) =>
            params.sessionMessageSubscribers?.get(sessionKey).has(c.connId),
          ))
      ) {
        // Scoped clients opt out of legacy broadcast fanout. The server-side
        // subscription registry is the authority, so client filtering cannot leak a sibling tab.
        continue;
      }
      const nextSeq = (clientSeq.get(c) ?? 0) + 1;
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (!slow) {
        reportedSlowPayloadClients.delete(c);
      } else if (!reportedSlowPayloadClients.has(c)) {
        reportedSlowPayloadClients.add(c);
        logRejectedLargePayload({
          surface: "gateway.ws.outbound_buffer",
          bytes: c.socket.bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: opts?.dropIfSlow ? "ws_send_buffer_drop" : "ws_send_buffer_close",
        });
      }
      if (slow && opts?.dropIfSlow) {
        if (!isTargeted) {
          clientSeq.set(c, nextSeq);
        }
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        const eventSeq = isTargeted ? undefined : nextSeq;
        if (!isTargeted) {
          clientSeq.set(c, nextSeq);
        }
        const base = getFrameBase();
        const seqFragment = eventSeq === undefined ? "" : `,"seq":${eventSeq}`;
        const frame = `{"type":"event","event":${base.eventJSON}${base.payloadFragment}${seqFragment}${base.stateVersionFragment}}`;
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) =>
    broadcastInternal(event, payload, opts);

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  const getBufferedAmount: GatewayBufferedAmountFn = (connId) => {
    for (const client of params.clients) {
      if (client.connId === connId) {
        return client.socket.bufferedAmount;
      }
    }
    return undefined;
  };

  const broadcastPluginEvent: GatewayPluginEventBroadcastFn = (event, payload, scope) => {
    if (!event.startsWith("plugin.") || event.startsWith("plugin.approval.")) {
      throw new Error(`invalid plugin gateway event: ${event}`);
    }
    if (scope !== READ_SCOPE && scope !== WRITE_SCOPE && scope !== ADMIN_SCOPE) {
      throw new Error("invalid plugin gateway event scope");
    }
    broadcastInternal(event, payload, undefined, undefined, scope);
  };

  return { broadcast, broadcastToConnIds, broadcastPluginEvent, getBufferedAmount };
}
