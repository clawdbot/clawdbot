import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
// Gateway WebSocket broadcaster.
// Applies event scope guards and slow-consumer handling before sending frames.
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { queuePluginSessionsChanged } from "../plugins/gateway-events.js";
import { isBrowserCopilotClient } from "../utils/message-channel.js";
import {
  GATEWAY_EVENT_DEVICE_PAIR_CHANGED,
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
} from "./events.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
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
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

// Pairing scope is for device-pairing handshakes only; chat transcript events
// require operator-level session access. Pairing-scoped and node-role clients
// must not passively receive chat-class broadcasts.
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [READ_SCOPE],
  chat: [READ_SCOPE],
  "chat.metadata.changed": [READ_SCOPE],
  "board.changed": [READ_SCOPE],
  "board.command": [READ_SCOPE],
  "progressCard.changed": [READ_SCOPE],
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
  // The frame cadence itself exposes person activity; match system-presence access.
  presence: [READ_SCOPE],
  shutdown: [],
  "gateway.suspension": [],
  tick: [],
  "talk.event": [READ_SCOPE],
  "talk.mode": [TALK_SCOPE],
  task: [READ_SCOPE],
  "task.suggestion": [READ_SCOPE],
  "update.available": [],
  [GATEWAY_EVENT_UPDATE_RUN_CHANGED]: [ADMIN_SCOPE],
  // Hash-only change notice after a persisted config write; content stays
  // behind the operator-scoped config.get.
  "config.changed": [READ_SCOPE],
  "users.prefs.changed": [READ_SCOPE],
  "mentions.changed": [READ_SCOPE],
  "skills.changed": [READ_SCOPE],
  "voicewake.changed": [READ_SCOPE],
  "voicewake.routing.changed": [READ_SCOPE],
  [GATEWAY_EVENT_DEVICE_PAIR_CHANGED]: [PAIRING_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "device.pair.setup.completed": [PAIRING_SCOPE],
  "device.pair.setup.deliveryUncertain": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  "node.presence": [READ_SCOPE],
  "node.hostStats": [READ_SCOPE],
  [GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED]: [READ_SCOPE],
  "sessions.catalog.host": [READ_SCOPE],
  "sessions.changed": [READ_SCOPE],
  "controlUi.sessionPullRequests.changed": [READ_SCOPE],
  "plugins.controlUi.changed": [READ_SCOPE],
  "session.approval": [APPROVALS_SCOPE],
  "session.message": [READ_SCOPE],
  "session.observer": [READ_SCOPE],
  "session.operation": [READ_SCOPE],
  "session.sharing": [READ_SCOPE],
  "session.sharing.evidence": [READ_SCOPE],
  "session.suggestion": [READ_SCOPE],
  "session.typing": [READ_SCOPE],
  "session.tool": [READ_SCOPE],
  // Operator terminal byte/exit streams. Admin-gated to match the terminal.*
  // methods; also targeted to the owning connection at broadcast time.
  "terminal.data": [ADMIN_SCOPE],
  "terminal.exit": [ADMIN_SCOPE],
  "portal.changed": [READ_SCOPE],
};

// Opt-in scoped clients never receive session-bearing broadcasts without an
// authoritative registry key, including malformed/sessionless agent events.
const log = createSubsystemLogger("gateway/broadcast");

const SESSION_SUBSCRIPTION_EVENTS = new Set([
  "agent",
  "chat",
  "chat.side_result",
  "session.observer",
  // Mirrors the raw agent tool event (full args/result snapshots) onto
  // session subscribers; omitting it here would hand scoped clients the
  // exact payload the registry gate suppresses on the `agent` event.
  "session.tool",
]);

function serializeFrameField(name: "payload" | "stateVersion", value: unknown): string {
  // Keep the wrapper for toJSON's property key and reuse its serialized field.
  // Only splice wrappers that still start with that field after inherited toJSON.
  const fieldJSON = JSON.stringify({ [name]: value });
  return fieldJSON.startsWith(`{"${name}":`) ? `,${fieldJSON.slice(1, -1)}` : "";
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
  if (required.includes(TALK_SCOPE)) {
    return scopes.includes(TALK_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return required.some((scope) => scopes.includes(scope));
}

type FrameBase = { eventJSON: string; payloadFragment: string; stateVersionFragment: string };
// ws bufferedAmount includes the unmasked server frame's 2/4/10-byte header.
const MAX_SERVER_FRAME_HEADER_BYTES = 10;

function frameWithSequence(base: FrameBase, seq: number, payload = base.payloadFragment): string {
  return `{"type":"event","event":${base.eventJSON}${payload},"seq":${seq}${base.stateVersionFragment}}`;
}

type PendingLiveText = {
  group: AbortSignal;
  key: string;
  payload: unknown;
  bytes: number;
  isCurrent?: () => boolean;
  send: () => void;
};
type ClientDelivery = {
  socket: GatewayWsClient["socket"];
  retired: boolean;
  inFlight: number;
  draining: boolean;
  bytes: number;
  groups: Map<AbortSignal, { entries: Map<string, PendingLiveText>; retire: () => void }>;
  pending: Set<PendingLiveText>;
};

export function createGatewayBroadcaster(params: {
  clients: GatewayClientRegistry;
  preparePresenceProjection?: (
    presence: SystemPresence[],
  ) => (client: GatewayWsClient) => SystemPresence[];
  sessionMessageSubscribers?: SessionMessageSubscriberRegistry;
  canReceiveSessionEvent?: (
    client: GatewayWsClient,
    sessionKeys: readonly string[],
    agentId?: string,
    event?: string,
    payload?: unknown,
  ) => boolean;
  onBroadcast?: (event: string, payload: unknown, opts?: GatewayBroadcastOpts) => void;
}) {
  const clientSeq = new WeakMap<GatewayWsClient, number>();
  const reportedSlowPayloadClients = new WeakSet<GatewayWsClient>();
  const deliveries = new WeakMap<GatewayWsClient, ClientDelivery>();
  const deliveryFor = (client: GatewayWsClient) => {
    let state = deliveries.get(client);
    if (!state || state.socket !== client.socket) {
      if (state) {
        clearPending(state);
      }
      state = {
        socket: client.socket,
        retired: false,
        inFlight: 0,
        draining: false,
        bytes: 0,
        groups: new Map(),
        pending: new Set(),
      };
      deliveries.set(client, state);
    }
    return state;
  };
  // Pending text and socket writes share the connection budget and upstream backpressure.
  const bufferedBytes = (state: ClientDelivery) => state.socket.bufferedAmount + state.bytes;
  const takePending = (state: ClientDelivery, entry: PendingLiveText) => {
    state.pending.delete(entry);
    const group = state.groups.get(entry.group)!;
    group.entries.delete(entry.key);
    if (!group.entries.size) {
      entry.group.removeEventListener("abort", group.retire);
      state.groups.delete(entry.group);
    }
    state.bytes -= entry.bytes;
  };
  const clearPending = (state: ClientDelivery) => {
    for (const entry of state.pending) {
      takePending(state, entry);
    }
  };
  const isCurrent = (predicate?: () => boolean) => {
    try {
      return predicate?.() !== false;
    } catch {
      return false;
    }
  };
  const drain = (state: ClientDelivery, group?: AbortSignal) => {
    if (state.retired || state.draining) {
      return;
    }
    state.draining = true;
    try {
      // A barrier may overtake in-flight writes, but never another group's queue.
      // The guard also contains synchronous send callbacks without recursive drains.
      for (const entry of state.pending) {
        if (group ? entry.group !== group : state.inFlight !== 0) {
          if (group) {
            continue;
          }
          break;
        }
        takePending(state, entry);
        try {
          entry.send();
        } catch (err) {
          log.error(`broadcast pending send failed: ${formatErrorMessage(err)}`);
        }
      }
    } finally {
      state.draining = false;
    }
  };

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
    explicitPluginScope?: GatewayPluginEventScope,
    retained?: { client: GatewayWsClient; socket: GatewayWsClient["socket"]; base: FrameBase },
  ) => {
    if (!retained && event === "sessions.changed") {
      // Delivery is queued here so process-local handlers run after websocket fanout returns.
      queuePluginSessionsChanged(payload);
    }
    const live = opts?.liveText;
    if (params.clients.size === 0) {
      return;
    }
    const { sessionKeys, agentId } = resolveBroadcastSessionScope(
      payload,
      opts?.sessionKeys,
      opts?.agentId,
    );
    const isTargeted = Boolean(targetConnIds);
    const presencePayload =
      // SAFETY: Internal presence producers emit { presence: SystemPresence[] }; wire input cannot publish events.
      event === "presence" ? (payload as { presence: SystemPresence[] }) : undefined;
    let projectPresence: ((client: GatewayWsClient) => SystemPresence[]) | undefined;
    let outboundEventLogged = false;
    let frameBase: FrameBase | undefined = retained?.base;
    let frameFields: Omit<FrameBase, "payloadFragment"> | undefined;
    const frameBaseFor = (value: unknown): FrameBase => {
      frameFields ??= {
        eventJSON: JSON.stringify(event),
        stateVersionFragment:
          opts?.stateVersion === undefined
            ? ""
            : serializeFrameField("stateVersion", opts.stateVersion),
      };
      return {
        ...frameFields,
        payloadFragment: presencePayload ? "" : serializeFrameField("payload", value),
      };
    };
    // Lazy so filtered-out broadcasts (zero eligible clients) never pay
    // JSON.stringify for the payload.
    const getFrameBase = () => {
      return (frameBase ??= frameBaseFor(payload));
    };
    const sessionSubscriptionVerified = opts?.sessionSubscriptionVerified === true;
    const isSessionSubscriptionEvent = SESSION_SUBSCRIPTION_EVENTS.has(event);
    const sessionMessageSubscribers = params.sessionMessageSubscribers;
    let sessionSubscriberConnIdsByKey: Array<ReadonlySet<string> | undefined> | undefined;
    const recipients = retained
      ? [retained.client]
      : targetConnIds
        ? params.clients.getByConnectionIds(targetConnIds)
        : params.clients;
    for (const c of recipients) {
      // Closing nodes remain discoverable until their owner drains admitted lifecycle work.
      if (
        !params.clients.has(c) ||
        (retained && c.socket !== retained.socket) ||
        c.invalidated === true ||
        c.socket.readyState !== WEBSOCKET_OPEN_READY_STATE
      ) {
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
        sessionSubscriptionVerified ||
        ((isBrowserCopilotClient(c.connect.client) ||
          hasGatewayClientCap(c.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)) &&
          isSessionSubscriptionEvent);
      if (
        requiresSessionSubscription &&
        !(isTargeted && sessionSubscriptionVerified && !retained)
      ) {
        if (!sessionKeys.length || !sessionMessageSubscribers) {
          continue;
        }
        // Resolve keys lazily to preserve short-circuit order, then reuse their live sets across clients.
        // This avoids repeated normalization and map lookups without snapshotting recipients.
        sessionSubscriberConnIdsByKey ??= [];
        let subscribed = false;
        let sessionKeyIndex = 0;
        for (const sessionKey of sessionKeys) {
          const subscriberConnIds = (sessionSubscriberConnIdsByKey[sessionKeyIndex] ??=
            sessionMessageSubscribers.get(sessionKey));
          if (subscriberConnIds.has(c.connId)) {
            subscribed = true;
            break;
          }
          sessionKeyIndex += 1;
        }
        if (!subscribed) {
          // Scoped clients opt out of cross-session fanout, including critical observer announces.
          // The registry is authoritative; for cap-gated events, unscoped Control UI clients keep full fanout.
          continue;
        }
      }
      // Retirement releases progress without suppressing its captured abort terminal.
      if ((retained && !isCurrent(live?.isCurrent)) || (live?.coalesce && live.group.aborted)) {
        continue;
      }
      if (!outboundEventLogged) {
        outboundEventLogged = true;
        logWs("out", "event", () => {
          const logMeta: Record<string, unknown> = {
            event,
            seq: "per-client",
            clients: params.clients.size,
            targets: targetConnIds ? targetConnIds.size : undefined,
            dropIfSlow: opts?.dropIfSlow,
            presenceVersion: opts?.stateVersion?.presence,
            healthVersion: opts?.stateVersion?.health,
          };
          if (event === "agent") {
            Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
          }
          return logMeta;
        });
      }
      const state = deliveryFor(c);
      if (live && !live.coalesce) {
        drain(state, live.group);
      }
      if (state.retired) {
        continue;
      }
      const nextSeq = (clientSeq.get(c) ?? 0) + 1;
      const bufferedAmount = bufferedBytes(state);
      const slow = bufferedAmount > MAX_BUFFERED_BYTES;
      if (!slow) {
        reportedSlowPayloadClients.delete(c);
      } else if (!reportedSlowPayloadClients.has(c)) {
        reportedSlowPayloadClients.add(c);
        logRejectedLargePayload({
          surface: "gateway.ws.outbound_buffer",
          bytes: bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: opts?.dropIfSlow ? "ws_send_buffer_drop" : "ws_send_buffer_close",
        });
      }
      if (slow && opts?.dropIfSlow) {
        // Consume the seq for the dropped frame so the client's gap detector
        // sees the loss instead of a silently thinner stream.
        clientSeq.set(c, nextSeq);
        continue;
      }
      if (slow) {
        state.retired = true;
        clearPending(state);
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        c.socket.terminate();
        continue;
      }
      if (!retained && live?.coalesce && state.inFlight > 0) {
        let previous = state.groups.get(live.group)?.entries.get(live.coalesce.key);
        if (previous && !isCurrent(previous.isCurrent)) {
          takePending(state, previous);
          previous = undefined;
        }
        try {
          const nextPayload = previous ? live.coalesce.merge(previous.payload, payload) : payload;
          const base = previous ? frameBaseFor(nextPayload) : getFrameBase();
          // Reserve the complete frame and maximum sequence width; unrelated sends
          // can advance the sequence while this entry is waiting to drain.
          const bytes =
            Buffer.byteLength(frameWithSequence(base, Number.MAX_SAFE_INTEGER)) +
            MAX_SERVER_FRAME_HEADER_BYTES;
          if (bufferedBytes(state) - (previous?.bytes ?? 0) + bytes <= MAX_BUFFERED_BYTES) {
            if (previous) {
              takePending(state, previous);
            }
            const socket = c.socket;
            const entry: PendingLiveText = {
              group: live.group,
              key: live.coalesce.key,
              payload: nextPayload,
              bytes,
              isCurrent: live.isCurrent,
              send: () =>
                broadcastInternal(event, nextPayload, opts, targetConnIds, explicitPluginScope, {
                  client: c,
                  socket,
                  base,
                }),
            };
            let group = state.groups.get(live.group);
            if (!group) {
              const entries = new Map<string, PendingLiveText>();
              const retire = () => {
                // Release only this generation; written frames remain socket-owned.
                for (const pending of entries.values()) {
                  takePending(state, pending);
                }
              };
              group = { entries, retire };
              state.groups.set(live.group, group);
              live.group.addEventListener("abort", retire, { once: true });
            }
            group.entries.set(entry.key, entry);
            state.pending.add(entry);
            state.bytes += bytes;
            continue;
          }
        } catch (err) {
          log.error(
            `broadcast serialization failed for event ${event}: ${formatErrorMessage(err)}`,
          );
          return;
        }
        // Flush the old deltas, then send this ingress unmerged under the normal slow policy.
        drain(state, live.group);
        broadcastInternal(event, payload, opts, targetConnIds, explicitPluginScope, {
          client: c,
          socket: c.socket,
          base: getFrameBase(),
        });
        continue;
      }
      // Build the frame before consuming the seq: a serialization failure
      // (circular/BigInt payload) throws identically for every client, and
      // advancing seqs for a frame that never existed would fire every gap
      // detector at once — a synchronized reconnect storm with no evidence.
      let frame: string;
      try {
        const base = getFrameBase();
        let payloadFragment = base.payloadFragment;
        if (presencePayload) {
          // Presence contains session references. Only the connection owner's
          // recipient projection may cross this boundary; never send the raw roster.
          if (!params.preparePresenceProjection) {
            throw new Error("presence recipient projection unavailable");
          }
          projectPresence ??= params.preparePresenceProjection(presencePayload.presence);
          payloadFragment = serializeFrameField("payload", {
            ...presencePayload,
            presence: projectPresence(c),
          });
        }
        frame = frameWithSequence(base, nextSeq, payloadFragment);
      } catch (err) {
        log.error(`broadcast serialization failed for event ${event}: ${formatErrorMessage(err)}`);
        return;
      }
      // Targeted frames ride the same per-client sequence as fanout frames:
      // an unstamped frame is invisible to the client's gap detector, so a
      // drop between two targeted sends would go unnoticed forever.
      clientSeq.set(c, nextSeq);
      state.inFlight += 1;
      let finished = false;
      const sent = (err?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        state.inFlight -= 1;
        // ws fails every queued write when compression loses its socket. Settle
        // each callback, but retire this delivery generation only once.
        if (state.retired) {
          return;
        }
        if (err) {
          state.retired = true;
          clearPending(state);
          log.error(`broadcast send failed conn=${c.connId}: ${formatErrorMessage(err)}`, {
            event,
          });
          state.socket.terminate();
        } else {
          drain(state);
        }
      };
      try {
        state.socket.send(frame, sent);
      } catch (err) {
        sent(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) => {
    params.onBroadcast?.(event, payload, opts);
    broadcastInternal(event, payload, opts);
  };

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    broadcastInternal(event, payload, opts, connIds);
  };

  const getBufferedAmount: GatewayBufferedAmountFn = (connId) => {
    const client = params.clients.getByConnectionId(connId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return undefined;
    }
    const state = deliveryFor(client);
    // Failed compression retains ws's queued byte count after transport retirement.
    return state.retired ? undefined : bufferedBytes(state);
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
