// Node gateway methods manage paired node discovery, pairing lifecycle, command
// invocation, wake delivery, events, pending work, and node metadata updates.
import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type ConnectParams,
  ErrorCodes,
  errorShape,
  validateNodeDescribeParams,
  validateNodeEventParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePendingAckParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRemoveParams,
  validateNodePluginToolsUpdateParams,
  validateNodeSkillsUpdateParams,
  validateNodeRenameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getPairedDevice,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  removePairedDeviceRole,
} from "../../infra/device-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
} from "../../infra/node-pairing.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  sendApnsAlert,
  sendApnsBackgroundWake,
  shouldClearStoredApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
} from "../../infra/push-apns.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { replaceRemoteNodeSkills } from "../../skills/runtime/remote-skills.js";
import {
  recordRemoteNodeInfo,
  refreshRemoteNodeBins,
  removeRemoteNodeInfo,
} from "../../skills/runtime/remote.js";
import { createKnownNodeCatalog, getKnownNode, listKnownNodes } from "../node-catalog.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
} from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
import type { NodeSession } from "../node-registry.js";
import { ADMIN_SCOPE, PAIRING_SCOPE } from "../operator-scopes.js";
import { refreshClientPluginNodeCapability } from "../plugin-node-capability.js";
import type { NodeEventContext } from "../server-node-events-types.js";
import {
  deniesCrossDeviceManagement,
  pairedDeviceHasNonOperatorRole,
  resolveDeviceManagementAuthz,
  type DeviceManagementAuthz,
} from "./device-management-authz.js";
import { emitDeviceManagementSecurityEvent } from "./device-management-security.js";
import {
  NODE_WAKE_RECONNECT_POLL_MS,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  nodeWakeById,
  nodeWakeNudgeById,
  type NodeWakeAttempt,
} from "./nodes-wake-state.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondInvalidParams,
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

export {
  clearNodeWakeState,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
} from "./nodes-wake-state.js";

const NODE_WAKE_THROTTLE_MS = 15_000;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 60_000;
const NODE_PENDING_ACTION_TTL_MS = 10 * 60_000;
const NODE_PENDING_ACTION_MAX_PER_NODE = 64;
const TALK_PTT_COMMANDS = new Set([
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
]);
const BROWSER_PROXY_REQUIRED_SCOPE = "operator.admin";
const talkPttEventSeqBySessionId = new Map<string, number>();

type NodeWakeNudgeAttempt = {
  sent: boolean;
  throttled: boolean;
  reason: "throttled" | "no-registration" | "no-auth" | "send-error" | "apns-not-ok" | "sent";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

type PendingNodeAction = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
  enqueuedAtMs: number;
};

const pendingNodeActionsById = new Map<string, PendingNodeAction[]>();

function canReadPendingNodePairing(client: GatewayClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(PAIRING_SCOPE);
}

function safeNodeReadProjection(
  node: NodeListNode,
  ownDeviceId: string | undefined,
): NodeListNode | null {
  if (!node.paired && !node.connected) {
    return null;
  }
  const {
    pendingRequestId,
    pendingDeclaredCaps: _pendingDeclaredCaps,
    pendingDeclaredCommands: _pendingDeclaredCommands,
    pendingDeclaredPermissions: _pendingDeclaredPermissions,
    ...safeNode
  } = node;
  // A read-scoped mobile client may guide its user to approve this phone, but must not expose
  // another node's approval target or any pending capability declaration.
  return node.nodeId === ownDeviceId && pendingRequestId
    ? { ...safeNode, pendingRequestId }
    : safeNode;
}

function nodeReadCallerDeviceId(client: GatewayClient | null): string | undefined {
  return normalizeOptionalString(client?.connect?.device?.id);
}

function isVisibleNode(node: NodeListNode | null): node is NodeListNode {
  return node !== null;
}

function listNodesForClient(params: {
  client: GatewayClient | null;
  pairedDevices: Awaited<ReturnType<typeof listDevicePairing>>["paired"];
  pairedNodes: Awaited<ReturnType<typeof listNodePairing>>["paired"];
  pendingNodes: Awaited<ReturnType<typeof listNodePairing>>["pending"];
  connectedNodes: readonly NodeSession[];
}): NodeListNode[] {
  const catalog = createKnownNodeCatalog({
    pairedDevices: params.pairedDevices,
    pairedNodes: params.pairedNodes,
    pendingNodes: params.pendingNodes,
    connectedNodes: params.connectedNodes,
  });
  const nodes = listKnownNodes(catalog);
  if (canReadPendingNodePairing(params.client)) {
    return nodes;
  }
  const ownDeviceId = nodeReadCallerDeviceId(params.client);
  return nodes.map((node) => safeNodeReadProjection(node, ownDeviceId)).filter(isVisibleNode);
}

function normalizeBrowserProxyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length <= 1) {
    return withLeadingSlash;
  }
  return withLeadingSlash.replace(/\/+$/, "");
}

function isPersistentBrowserProxyMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserProxyPath(path);
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

function isForbiddenBrowserProxyMutation(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const candidate = params as { method?: unknown; path?: unknown };
  const method = (normalizeOptionalString(candidate.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(candidate.path) ?? "";
  return Boolean(method && path && isPersistentBrowserProxyMutation(method, path));
}

function clientHasOperatorAdminScope(client: GatewayClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(BROWSER_PROXY_REQUIRED_SCOPE);
}

function normalizePluginSurfaceRefreshParams(params: unknown): { surface: string } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const surface = normalizeOptionalString((params as { surface?: unknown }).surface);
  if (!surface) {
    return undefined;
  }
  return { surface };
}

function respondRefreshedPluginSurface(params: {
  surface: string;
  client: GatewayClient | null;
  respond: RespondFn;
}) {
  const refreshed = params.client
    ? refreshClientPluginNodeCapability({
        client: params.client,
        surface: params.client.pluginNodeCapabilitySurfaces?.[params.surface] ?? {
          surface: params.surface,
        },
      })
    : undefined;
  if (!refreshed) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${params.surface} plugin surface unavailable`),
    );
    return;
  }
  params.respond(
    true,
    {
      surface: refreshed.surface,
      pluginSurfaceUrls: { [refreshed.surface]: refreshed.scopedUrl },
      expiresAtMs: refreshed.expiresAtMs,
    },
    undefined,
  );
}

async function resolveDirectNodePushConfig() {
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  return auth.ok
    ? { ok: true as const, auth: auth.value }
    : { ok: false as const, error: auth.error };
}

function resolveRelayNodePushConfig(
  cfg: OpenClawConfig,
  registration: Extract<
    NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
    { transport: "relay" }
  >,
) {
  const relay = resolveApnsRelayConfigFromEnv(process.env, cfg.gateway, {
    registrationRelayOrigin: registration.relayOrigin,
  });
  return relay.ok
    ? { ok: true as const, relayConfig: relay.value }
    : { ok: false as const, error: relay.error };
}

async function clearStaleApnsRegistrationIfNeeded(
  registration: NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
  nodeId: string,
  params: { status: number; reason?: string },
) {
  if (
    !shouldClearStoredApnsRegistration({
      registration,
      result: params,
    })
  ) {
    return;
  }
  await clearApnsRegistrationIfCurrent({
    nodeId,
    registration,
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isForegroundRestrictedIosCommand(command: string): boolean {
  return (
    isForegroundRestrictedPluginNodeCommand(command) ||
    command.startsWith("camera.") ||
    command.startsWith("screen.") ||
    command.startsWith("talk.")
  );
}

function shouldQueueAsPendingForegroundAction(params: {
  platform?: string;
  command: string;
  error: unknown;
}): boolean {
  // iOS cannot run camera/screen/Talk commands in the background. Queue only
  // those foreground-only commands when the node explicitly reports that state.
  const platform = normalizeLowercaseStringOrEmpty(params.platform);
  if (!platform.startsWith("ios") && !platform.startsWith("ipados")) {
    return false;
  }
  if (!isForegroundRestrictedIosCommand(params.command)) {
    return false;
  }
  const error =
    params.error && typeof params.error === "object"
      ? (params.error as { code?: unknown; message?: unknown })
      : null;
  const code = normalizeOptionalString(error?.code)?.toUpperCase() ?? "";
  const message = normalizeOptionalString(error?.message)?.toUpperCase() ?? "";
  return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}

function prunePendingNodeActions(nodeId: string, nowMs: number): PendingNodeAction[] {
  const queue = pendingNodeActionsById.get(nodeId) ?? [];
  const minTimestampMs = nowMs - NODE_PENDING_ACTION_TTL_MS;
  const live = queue.filter((entry) => entry.enqueuedAtMs >= minTimestampMs);
  if (live.length === 0) {
    pendingNodeActionsById.delete(nodeId);
    return [];
  }
  pendingNodeActionsById.set(nodeId, live);
  return live;
}

function clearRemovedNodeRuntimeState(params: {
  nodeId: string;
  context: Pick<GatewayRequestContext, "nodeRegistry">;
}) {
  pendingNodeActionsById.delete(params.nodeId);
  params.context.nodeRegistry.updateSurface(params.nodeId, {
    caps: [],
    commands: [],
    permissions: undefined,
  });
  removeRemoteNodeInfo(params.nodeId);
}

function broadcastRemovedNodePairing(params: {
  context: Pick<GatewayRequestContext, "broadcast">;
  nodeId: string;
}) {
  params.context.broadcast(
    "node.pair.resolved",
    {
      requestId: "",
      nodeId: params.nodeId,
      decision: "removed",
      ts: Date.now(),
    },
    { dropIfSlow: true },
  );
}

function emitNodeRoleRemovalSecurityEvent(params: {
  authz: DeviceManagementAuthz;
  deviceId: string;
  reason?: string;
  removedDevice?: boolean;
}): void {
  const denied = params.reason !== undefined;
  emitDeviceManagementSecurityEvent({
    action: denied ? "device.role.removal_denied" : "device.role.removed",
    outcome: denied ? "denied" : "success",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.deviceId,
    policyId: "gateway.device-pairing",
    decision: denied ? "deny" : "allow",
    controlId: "node.pair.remove",
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      role: "node",
      ...(params.removedDevice !== undefined ? { removed_device: params.removedDevice } : {}),
    },
  });
}

async function removePairedDeviceBackedNode(params: {
  nodeId: string;
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "disconnectClientsForDevice" | "invalidateClientsForDevice" | "logGateway"
  >;
}): Promise<
  | { status: "removed"; nodeId: string; disconnectDeviceId: string }
  | { status: "denied"; message: string }
  | { status: "unknown" }
> {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    return { status: "unknown" };
  }
  const paired = await getPairedDevice(nodeId);
  if (!paired || !listApprovedPairedDeviceRoles(paired).includes("node")) {
    return { status: "unknown" };
  }

  const authz = resolveDeviceManagementAuthz(params.client, nodeId);
  if (deniesCrossDeviceManagement(authz)) {
    params.context.logGateway.warn(
      `node pairing removal denied node=${nodeId} reason=device-ownership-mismatch`,
    );
    emitNodeRoleRemovalSecurityEvent({
      authz,
      deviceId: nodeId,
      reason: "device-ownership-mismatch",
    });
    return { status: "denied", message: "node pairing removal denied" };
  }
  // Mirror device.pair.remove: the admin requirement for mixed-role rows only
  // applies to device-token self-service callers (callerDeviceId set). Shared-auth
  // / CLI operators holding operator.pairing manage pairings on others' behalf and
  // are allowed to remove non-operator (e.g. node) rows without operator.admin.
  if (authz.callerDeviceId && !authz.isAdminCaller && pairedDeviceHasNonOperatorRole(paired)) {
    params.context.logGateway.warn(
      `node pairing removal denied node=${nodeId} reason=role-management-requires-admin`,
    );
    emitNodeRoleRemovalSecurityEvent({
      authz,
      deviceId: nodeId,
      reason: "role-management-requires-admin",
    });
    return { status: "denied", message: "node pairing removal denied" };
  }

  const removed = await removePairedDeviceRole({ deviceId: nodeId, role: "node" });
  if (!removed) {
    return { status: "unknown" };
  }
  params.context.logGateway.info(`node pairing removed device-backed node=${removed.deviceId}`);
  emitNodeRoleRemovalSecurityEvent({
    authz,
    deviceId: removed.deviceId,
    removedDevice: removed.removedDevice,
  });
  // Match device.pair.remove: invalidate before responding so pipelined frames
  // on the affected device token are rejected. The caller queues the hard close
  // only after the success response is emitted.
  params.context.invalidateClientsForDevice?.(removed.deviceId, {
    role: "node",
    reason: "device-pair-removed",
  });
  return { status: "removed", nodeId: removed.deviceId, disconnectDeviceId: removed.deviceId };
}

function enqueuePendingNodeAction(params: {
  nodeId: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
}): PendingNodeAction {
  const nowMs = Date.now();
  const queue = prunePendingNodeActions(params.nodeId, nowMs);
  const existing = queue.find((entry) => entry.idempotencyKey === params.idempotencyKey);
  if (existing) {
    // Keep retries idempotent so callers do not create duplicate foreground
    // actions while the node is still backgrounded.
    return existing;
  }
  const entry: PendingNodeAction = {
    id: randomUUID(),
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON: params.paramsJSON,
    idempotencyKey: params.idempotencyKey,
    enqueuedAtMs: nowMs,
  };
  queue.push(entry);
  if (queue.length > NODE_PENDING_ACTION_MAX_PER_NODE) {
    queue.splice(0, queue.length - NODE_PENDING_ACTION_MAX_PER_NODE);
  }
  pendingNodeActionsById.set(params.nodeId, queue);
  return entry;
}

function listPendingNodeActions(nodeId: string): PendingNodeAction[] {
  return prunePendingNodeActions(nodeId, Date.now());
}

function refreshConnectedNodeSurfaceCaches(params: {
  context: GatewayRequestContext;
  nodeSession: NodeSession;
  cfg?: OpenClawConfig;
}) {
  const cfg = params.cfg ?? params.context.getRuntimeConfig();
  const { nodeSession } = params;
  recordRemoteNodeInfo({
    nodeId: nodeSession.nodeId,
    connId: nodeSession.connId,
    displayName: nodeSession.displayName,
    platform: nodeSession.platform,
    deviceFamily: nodeSession.deviceFamily,
    commands: nodeSession.commands,
    remoteIp: nodeSession.remoteIp,
  });
  void refreshRemoteNodeBins({
    nodeId: nodeSession.nodeId,
    platform: nodeSession.platform,
    deviceFamily: nodeSession.deviceFamily,
    commands: nodeSession.commands,
    cfg,
  }).catch((err: unknown) =>
    params.context.logGateway.warn(
      `remote bin probe failed for ${nodeSession.nodeId}: ${formatErrorMessage(err)}`,
    ),
  );
}

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  client: { connect?: ConnectParams | null } | null;
  cfg: OpenClawConfig;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions(params.nodeId);
  if (pending.length === 0) {
    return pending;
  }
  // Re-filter queued actions against the node's current declared commands and
  // allowlist; app upgrades or permission changes can make old actions unsafe.
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: connect?.client?.platform,
    deviceFamily: connect?.client?.deviceFamily,
    caps: connect?.caps,
    commands: declaredCommands,
  });
  const allowed = pending.filter((entry) => {
    const result = isNodeCommandAllowed({
      command: entry.command,
      declaredCommands,
      allowlist,
    });
    return result.ok;
  });
  if (allowed.length !== pending.length) {
    if (allowed.length === 0) {
      pendingNodeActionsById.delete(params.nodeId);
    } else {
      pendingNodeActionsById.set(params.nodeId, allowed);
    }
  }
  return allowed;
}

function ackPendingNodeActions(nodeId: string, ids: string[]): PendingNodeAction[] {
  if (ids.length === 0) {
    return listPendingNodeActions(nodeId);
  }
  const pending = prunePendingNodeActions(nodeId, Date.now());
  const idSet = new Set(ids);
  const remaining = pending.filter((entry) => !idSet.has(entry.id));
  if (remaining.length === 0) {
    pendingNodeActionsById.delete(nodeId);
    return [];
  }
  pendingNodeActionsById.set(nodeId, remaining);
  return remaining;
}

function toPendingParamsJSON(params: unknown): string | undefined {
  if (params === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(params);
  } catch {
    return undefined;
  }
}

function emitTalkPttNodeEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast">;
  nodeId: string;
  command: string;
  payload: unknown;
}): void {
  if (!TALK_PTT_COMMANDS.has(params.command)) {
    return;
  }
  const payloadObj =
    typeof params.payload === "object" && params.payload !== null
      ? (params.payload as Record<string, unknown>)
      : {};
  const captureId = normalizeOptionalString(payloadObj.captureId) ?? randomUUID();
  const sessionId = `node:${params.nodeId}:talk:${captureId}`;
  const seq = (talkPttEventSeqBySessionId.get(sessionId) ?? 0) + 1;
  talkPttEventSeqBySessionId.set(sessionId, seq);
  while (talkPttEventSeqBySessionId.size > 2048) {
    const oldest = talkPttEventSeqBySessionId.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    talkPttEventSeqBySessionId.delete(oldest);
  }

  const type =
    params.command === "talk.ptt.start"
      ? "capture.started"
      : params.command === "talk.ptt.cancel"
        ? "capture.cancelled"
        : params.command === "talk.ptt.once"
          ? "capture.once"
          : "capture.stopped";
  const final = params.command !== "talk.ptt.start";
  const talkEvent = {
    id: `${sessionId}:${seq}`,
    type,
    sessionId,
    captureId,
    seq,
    timestamp: new Date().toISOString(),
    mode: "stt-tts",
    transport: "managed-room",
    brain: "agent-consult",
    final,
    payload: {
      nodeId: params.nodeId,
      command: params.command,
      status: normalizeOptionalString(payloadObj.status) ?? undefined,
      transcript: normalizeOptionalString(payloadObj.transcript) ?? undefined,
    },
  };
  params.context.broadcast(
    "talk.event",
    {
      nodeId: params.nodeId,
      command: params.command,
      talkEvent,
    },
    { dropIfSlow: true },
  );
}

export async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: { force?: boolean; wakeReason?: string; cfg?: OpenClawConfig },
): Promise<NodeWakeAttempt> {
  const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
  nodeWakeById.set(nodeId, state);

  if (state.inFlight) {
    return await state.inFlight;
  }

  const now = Date.now();
  const force = opts?.force === true;
  if (!force && state.lastWakeAtMs > 0 && now - state.lastWakeAtMs < NODE_WAKE_THROTTLE_MS) {
    return { available: true, throttled: true, path: "throttled", durationMs: 0 };
  }

  state.inFlight = (async () => {
    const startedAtMs = Date.now();
    const withDuration = (attempt: Omit<NodeWakeAttempt, "durationMs">): NodeWakeAttempt => ({
      ...attempt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });

    try {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        // Avoid leaking the state entry we speculatively set at the top of
        // maybeWakeNodeWithApns: this nodeId has no APNs registration, so the
        // throttle bookkeeping we just created will never be touched by the
        // WS-close cleanup path (clearNodeWakeState is only called for
        // registered nodes in ws-connection.ts).
        nodeWakeById.delete(nodeId);
        return withDuration({ available: false, throttled: false, path: "no-registration" });
      }

      let wakeResult;
      if (registration.transport === "relay") {
        const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig(), registration);
        if (!relay.ok) {
          return withDuration({
            available: false,
            throttled: false,
            path: "no-auth",
            apnsReason: relay.error,
          });
        }
        state.lastWakeAtMs = Date.now();
        wakeResult = await sendApnsBackgroundWake({
          registration,
          nodeId,
          wakeReason: opts?.wakeReason ?? "node.invoke",
          relayConfig: relay.relayConfig,
        });
      } else {
        const auth = await resolveDirectNodePushConfig();
        if (!auth.ok) {
          return withDuration({
            available: false,
            throttled: false,
            path: "no-auth",
            apnsReason: auth.error,
          });
        }
        state.lastWakeAtMs = Date.now();
        wakeResult = await sendApnsBackgroundWake({
          registration,
          nodeId,
          wakeReason: opts?.wakeReason ?? "node.invoke",
          auth: auth.auth,
        });
      }
      await clearStaleApnsRegistrationIfNeeded(registration, nodeId, wakeResult);
      if (!wakeResult.ok) {
        return withDuration({
          available: true,
          throttled: false,
          path: "send-error",
          apnsStatus: wakeResult.status,
          apnsReason: wakeResult.reason,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "sent",
        apnsStatus: wakeResult.status,
        apnsReason: wakeResult.reason,
      });
    } catch (err) {
      // Best-effort wake only.
      const message = formatErrorMessage(err);
      if (state.lastWakeAtMs === 0) {
        return withDuration({
          available: false,
          throttled: false,
          path: "send-error",
          apnsReason: message,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "send-error",
        apnsReason: message,
      });
    }
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = undefined;
  }
}

export async function maybeSendNodeWakeNudge(
  nodeId: string,
  opts?: { cfg?: OpenClawConfig },
): Promise<NodeWakeNudgeAttempt> {
  const startedAtMs = Date.now();
  const withDuration = (
    attempt: Omit<NodeWakeNudgeAttempt, "durationMs">,
  ): NodeWakeNudgeAttempt => ({
    ...attempt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  const lastNudgeAtMs = nodeWakeNudgeById.get(nodeId) ?? 0;
  if (lastNudgeAtMs > 0 && Date.now() - lastNudgeAtMs < NODE_WAKE_NUDGE_THROTTLE_MS) {
    return withDuration({ sent: false, throttled: true, reason: "throttled" });
  }

  const registration = await loadApnsRegistration(nodeId);
  if (!registration) {
    return withDuration({ sent: false, throttled: false, reason: "no-registration" });
  }
  try {
    let result;
    if (registration.transport === "relay") {
      const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig(), registration);
      if (!relay.ok) {
        return withDuration({
          sent: false,
          throttled: false,
          reason: "no-auth",
          apnsReason: relay.error,
        });
      }
      result = await sendApnsAlert({
        registration,
        nodeId,
        title: "OpenClaw needs a quick reopen",
        body: "Tap to reopen OpenClaw and restore the node connection.",
        relayConfig: relay.relayConfig,
      });
    } else {
      const auth = await resolveDirectNodePushConfig();
      if (!auth.ok) {
        return withDuration({
          sent: false,
          throttled: false,
          reason: "no-auth",
          apnsReason: auth.error,
        });
      }
      result = await sendApnsAlert({
        registration,
        nodeId,
        title: "OpenClaw needs a quick reopen",
        body: "Tap to reopen OpenClaw and restore the node connection.",
        auth: auth.auth,
      });
    }
    await clearStaleApnsRegistrationIfNeeded(registration, nodeId, result);
    if (!result.ok) {
      return withDuration({
        sent: false,
        throttled: false,
        reason: "apns-not-ok",
        apnsStatus: result.status,
        apnsReason: result.reason,
      });
    }
    nodeWakeNudgeById.set(nodeId, Date.now());
    return withDuration({
      sent: true,
      throttled: false,
      reason: "sent",
      apnsStatus: result.status,
      apnsReason: result.reason,
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    return withDuration({
      sent: false,
      throttled: false,
      reason: "send-error",
      apnsReason: message,
    });
  }
}

export async function waitForNodeReconnect(params: {
  nodeId: string;
  context: { nodeRegistry: { get: (nodeId: string) => unknown } };
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, NODE_WAKE_RECONNECT_WAIT_MS, 250);
  const pollMs = resolveTimerTimeoutMs(params.pollMs, NODE_WAKE_RECONNECT_POLL_MS, 50);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.context.nodeRegistry.get(params.nodeId)) {
      return true;
    }
    await delayMs(pollMs);
  }
  return Boolean(params.context.nodeRegistry.get(params.nodeId));
}

export const nodeHandlers: GatewayRequestHandlers = {
  "node.pair.list": async ({ params, respond }) => {
    if (!validateNodePairListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.list",
        validator: validateNodePairListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listNodePairing();
      respond(true, list, undefined);
    });
  },
  "node.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateNodePairApproveParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.approve",
        validator: validateNodePairApproveParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    // Intentionally fail closed for RPC callers without an explicit scoped session.
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    await respondUnavailableOnThrow(respond, async () => {
      const approved = await approveNodePairing(requestId, { callerScopes });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      if ("status" in approved && approved.status === "forbidden") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${approved.missingScope}`),
        );
        return;
      }
      if (!("node" in approved)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      const approvedNode = approved.node;
      const cfg = context.getRuntimeConfig();
      // Pairing allowlist, matching connect-time reconciliation: approved
      // dangerous surfaces (e.g. computer.act) stay on the live session so a
      // later arming works without a reconnect; invoke policy still gates use.
      const currentAllowlist = resolveNodePairingCommandAllowlist(cfg, {
        platform: approvedNode.platform,
        deviceFamily: approvedNode.deviceFamily,
        caps: approvedNode.caps,
        commands: approvedNode.commands,
        approvedCommands: approvedNode.commands,
      });
      const currentAllowedCommands = normalizeDeclaredNodeCommands({
        declaredCommands: approvedNode.commands ?? [],
        allowlist: currentAllowlist,
      });
      const updatedNode = context.nodeRegistry.updateSurface(approvedNode.nodeId, {
        caps: approvedNode.caps ?? [],
        commands: currentAllowedCommands,
        permissions: approvedNode.permissions,
      });
      if (updatedNode) {
        refreshConnectedNodeSurfaceCaches({ context, nodeSession: updatedNode, cfg });
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: approvedNode.nodeId,
          decision: "approved",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, approved, undefined);
    });
  },
  "node.pair.reject": async ({ params, respond, context }) => {
    if (!validateNodePairRejectParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.reject",
        validator: validateNodePairRejectParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    await respondUnavailableOnThrow(respond, async () => {
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: rejected.nodeId,
          decision: "rejected",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, rejected, undefined);
    });
  },
  // Remove a node pairing (CLI: `openclaw nodes remove`). This revokes the
  // device's `node` role in devices/paired.json, which drops the approved node
  // surface with it, and disconnects the device's node-role sessions: a
  // mixed-role device keeps its row and only loses the `node` role, a
  // node-only device row is deleted. Authz mirrors device.pair.remove:
  // operator.pairing may remove non-operator node rows; a device-token caller
  // revoking its own node role on a mixed-role device additionally needs
  // operator.admin (see removePairedDeviceBackedNode).
  "node.pair.remove": async ({ params, respond, context, client }) => {
    if (!validateNodePairRemoveParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.remove",
        validator: validateNodePairRemoveParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    await respondUnavailableOnThrow(respond, async () => {
      const deviceBacked = await removePairedDeviceBackedNode({ nodeId, client, context });
      if (deviceBacked.status === "denied") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deviceBacked.message));
        return;
      }
      if (deviceBacked.status !== "removed") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      try {
        clearRemovedNodeRuntimeState({ nodeId: deviceBacked.nodeId, context });
        broadcastRemovedNodePairing({ nodeId: deviceBacked.nodeId, context });
        respond(true, { nodeId: deviceBacked.nodeId }, undefined);
      } finally {
        // Preserve response-first shutdown on success, while guaranteeing the
        // hard close when runtime cleanup or later bookkeeping throws.
        queueMicrotask(() => {
          context.disconnectClientsForDevice?.(deviceBacked.disconnectDeviceId, {
            role: "node",
          });
        });
      }
    });
  },
  "node.rename": async ({ params, respond }) => {
    if (!validateNodeRenameParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.rename",
        validator: validateNodeRenameParams,
      });
      return;
    }
    const { nodeId, displayName } = params as {
      nodeId: string;
      displayName: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { nodeId: updated.nodeId, displayName: updated.displayName }, undefined);
    });
  },
  "node.list": async ({ params, respond, client, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.list",
        validator: validateNodeListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const nodes = listNodesForClient({
        client,
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes: context.nodeRegistry.listConnected(),
      });
      respond(true, { ts: Date.now(), nodes }, undefined);
    });
  },
  "node.describe": async ({ params, respond, client, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.describe",
        validator: validateNodeDescribeParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = normalizeOptionalString(nodeId) ?? "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const catalog = createKnownNodeCatalog({
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes: context.nodeRegistry.listConnected(),
      });
      const catalogNode = getKnownNode(catalog, id);
      const node =
        catalogNode && canReadPendingNodePairing(client)
          ? catalogNode
          : catalogNode
            ? safeNodeReadProjection(catalogNode, nodeReadCallerDeviceId(client))
            : null;
      if (!node) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { ts: Date.now(), ...node }, undefined);
    });
  },
  "node.pluginSurface.refresh": async ({ params, respond, client }) => {
    const parsed = normalizePluginSurfaceRefreshParams(params);
    if (!parsed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "surface required"));
      return;
    }
    respondRefreshedPluginSurface({
      surface: parsed.surface,
      client,
      respond,
    });
  },
  "node.pluginTools.update": async ({ params, respond, client, context }) => {
    if (!validateNodePluginToolsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pluginTools.update",
        validator: validateNodePluginToolsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodePluginTools(
      nodeId,
      client?.connId,
      params.tools,
    );
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    respond(true, { nodeId, tools: updated.nodePluginTools }, undefined);
  },
  "node.skills.update": async ({ params, respond, client, context }) => {
    if (!validateNodeSkillsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.skills.update",
        validator: validateNodeSkillsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodeSkills(nodeId, client?.connId, params.skills);
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    replaceRemoteNodeSkills({
      nodeId,
      displayName: updated.displayName,
      skills: updated.nodeSkills,
    });
    respond(true, { nodeId, skills: updated.nodeSkills }, undefined);
  },
  "node.pending.pull": async ({ params, respond, client, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.pull",
        validator: validateNodeListParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const pending = resolveAllowedPendingNodeActions({
      nodeId: trimmedNodeId,
      client,
      cfg: context.getRuntimeConfig(),
    });
    respond(
      true,
      {
        nodeId: trimmedNodeId,
        actions: pending.map((entry) => ({
          id: entry.id,
          command: entry.command,
          paramsJSON: entry.paramsJSON ?? null,
          enqueuedAtMs: entry.enqueuedAtMs,
        })),
      },
      undefined,
    );
  },
  "node.pending.ack": async ({ params, respond, client }) => {
    if (!validateNodePendingAckParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.ack",
        validator: validateNodePendingAckParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const ackIds = normalizeUniqueTrimmedStringList(params.ids);
    const remaining = ackPendingNodeActions(trimmedNodeId, ackIds);
    respond(
      true,
      {
        nodeId: trimmedNodeId,
        ackedIds: ackIds,
        remainingCount: remaining.length,
      },
      undefined,
    );
  },
  "node.invoke": async ({ params, respond, context, client, req }) => {
    if (!validateNodeInvokeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.invoke",
        validator: validateNodeInvokeParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey: string;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    };
    const nodeId = normalizeOptionalString(p.nodeId) ?? "";
    const command = normalizeOptionalString(p.command) ?? "";
    if (!nodeId || !command) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"),
      );
      return;
    }
    if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
          { details: { command } },
        ),
      );
      return;
    }
    if (command === "browser.proxy" && isForbiddenBrowserProxyMutation(p.params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke cannot mutate persistent browser profiles via browser.proxy",
          { details: { command } },
        ),
      );
      return;
    }
    if (command === "browser.proxy" && !clientHasOperatorAdminScope(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${BROWSER_PROXY_REQUIRED_SCOPE}`),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const cfg = context.getRuntimeConfig();
      let nodeSession = context.nodeRegistry.get(nodeId);
      if (!nodeSession) {
        const wakeReqId = req.id;
        const wakeFlowStartedAtMs = Date.now();
        context.logGateway.info(
          `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
        );

        const wake = await maybeWakeNodeWithApns(nodeId, { cfg });
        context.logGateway.info(
          `node wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
            `available=${wake.available} throttled=${wake.throttled} ` +
            `path=${wake.path} durationMs=${wake.durationMs} ` +
            `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
        );
        if (wake.available) {
          const waitStartedAtMs = Date.now();
          const waitTimeoutMs = NODE_WAKE_RECONNECT_WAIT_MS;
          const reconnected = await waitForNodeReconnect({
            nodeId,
            context,
            timeoutMs: waitTimeoutMs,
          });
          const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
          context.logGateway.info(
            `node wake stage=wait1 node=${nodeId} req=${wakeReqId} ` +
              `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
          );
        }
        nodeSession = context.nodeRegistry.get(nodeId);
        if (!nodeSession && wake.available) {
          const retryWake = await maybeWakeNodeWithApns(nodeId, { force: true, cfg });
          context.logGateway.info(
            `node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
              `available=${retryWake.available} throttled=${retryWake.throttled} ` +
              `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
              `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
          );
          if (retryWake.available) {
            const waitStartedAtMs = Date.now();
            const waitTimeoutMs = NODE_WAKE_RECONNECT_RETRY_WAIT_MS;
            const reconnected = await waitForNodeReconnect({
              nodeId,
              context,
              timeoutMs: waitTimeoutMs,
            });
            const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
            context.logGateway.info(
              `node wake stage=wait2 node=${nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
            );
          }
          nodeSession = context.nodeRegistry.get(nodeId);
        }
        if (!nodeSession) {
          const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
          const nudge = await maybeSendNodeWakeNudge(nodeId, { cfg });
          context.logGateway.info(
            `node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
              `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
              `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
          );
          context.logGateway.warn(
            `node wake done node=${nodeId} req=${wakeReqId} connected=false ` +
              `reason=not_connected totalMs=${totalDurationMs}`,
          );
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node not connected", {
              details: { code: "NOT_CONNECTED" },
            }),
          );
          return;
        }

        const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
        context.logGateway.info(
          `node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`,
        );
      }
      // A reload may revoke authority for an in-flight request, but it must not
      // retroactively grant one that was denied when admitted before node wake.
      for (const authorizationCfg of [cfg, context.getRuntimeConfig()]) {
        const allowlist = resolveNodeCommandAllowlist(authorizationCfg, {
          ...nodeSession,
          approvedCommands: nodeSession.commands,
        });
        const allowed = isNodeCommandAllowed({
          command,
          declaredCommands: nodeSession.commands,
          allowlist,
        });
        if (!allowed.ok) {
          const hint = buildNodeCommandRejectionHint(
            allowed.reason,
            command,
            nodeSession,
            authorizationCfg,
          );
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, hint, {
              details: { reason: allowed.reason, command },
            }),
          );
          return;
        }
      }

      const forwardedParams = sanitizeNodeInvokeParamsForForwarding({
        nodeId,
        command,
        rawParams: p.params,
        client,
        execApprovalManager: context.execApprovalManager,
      });
      if (!forwardedParams.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, forwardedParams.message, {
            details: forwardedParams.details ?? null,
          }),
        );
        return;
      }
      const policyResult = await applyPluginNodeInvokePolicy({
        context,
        client,
        nodeSession,
        command,
        params: forwardedParams.params,
        turnSource: {
          channel: p.turnSourceChannel,
          to: p.turnSourceTo,
          accountId: p.turnSourceAccountId,
          threadId: p.turnSourceThreadId,
        },
        timeoutMs: p.timeoutMs,
        idempotencyKey: p.idempotencyKey,
      });
      if (policyResult) {
        // Plugin policies can satisfy an invocation without crossing the raw
        // node command channel; still emit mirrored Talk events for UI state.
        if (!policyResult.ok) {
          const errorCode = policyResult.unavailable
            ? ErrorCodes.UNAVAILABLE
            : ErrorCodes.INVALID_REQUEST;
          respond(
            false,
            undefined,
            errorShape(errorCode, policyResult.message, {
              details: {
                ...policyResult.details,
                ...(policyResult.code ? { code: policyResult.code } : {}),
              },
            }),
          );
          return;
        }
        const payload = policyResult.payloadJSON
          ? safeParseJson(policyResult.payloadJSON)
          : policyResult.payload;
        emitTalkPttNodeEvent({
          context,
          nodeId,
          command,
          payload,
        });
        respond(
          true,
          {
            ok: true,
            nodeId,
            command,
            payload: policyResult.payload,
            payloadJSON: policyResult.payloadJSON ?? null,
          },
          undefined,
        );
        return;
      }
      const dispatchSession = context.nodeRegistry.get(nodeId);
      if (!dispatchSession || dispatchSession.connId !== nodeSession.connId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "node connection changed before dispatch", {
            retryable: true,
            details: { code: "ROUTE_CHANGED" },
          }),
        );
        return;
      }
      const dispatchCfg = context.getRuntimeConfig();
      const dispatchAllowlist = resolveNodeCommandAllowlist(dispatchCfg, {
        ...dispatchSession,
        approvedCommands: dispatchSession.commands,
      });
      const dispatchAllowed = isNodeCommandAllowed({
        command,
        declaredCommands: dispatchSession.commands,
        allowlist: dispatchAllowlist,
      });
      if (!dispatchAllowed.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            buildNodeCommandRejectionHint(
              dispatchAllowed.reason,
              command,
              dispatchSession,
              dispatchCfg,
            ),
            { details: { reason: dispatchAllowed.reason, command } },
          ),
        );
        return;
      }
      const res = await context.nodeRegistry.invoke({
        nodeId,
        expectedConnId: nodeSession.connId,
        command,
        params: forwardedParams.params,
        timeoutMs: p.timeoutMs,
        idempotencyKey: p.idempotencyKey,
      });
      if (!res.ok) {
        if (
          shouldQueueAsPendingForegroundAction({
            platform: nodeSession.platform,
            command,
            error: res.error,
          })
        ) {
          // Foreground-only iOS commands become pullable pending actions instead
          // of failing permanently while the device is locked/backgrounded.
          const paramsJSON = toPendingParamsJSON(forwardedParams.params);
          const queued = enqueuePendingNodeAction({
            nodeId,
            command,
            paramsJSON,
            idempotencyKey: p.idempotencyKey,
          });
          const wake = await maybeWakeNodeWithApns(nodeId, { cfg });
          context.logGateway.info(
            `node pending queued node=${nodeId} req=${req.id} command=${command} ` +
              `queuedId=${queued.id} wakePath=${wake.path} wakeAvailable=${wake.available}`,
          );
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "node command queued until iOS returns to foreground",
              {
                retryable: true,
                details: {
                  code: "QUEUED_UNTIL_FOREGROUND",
                  queuedActionId: queued.id,
                  nodeId,
                  command,
                  wake: {
                    path: wake.path,
                    available: wake.available,
                    throttled: wake.throttled,
                    apnsStatus: wake.apnsStatus,
                    apnsReason: wake.apnsReason,
                  },
                  nodeError: res.error ?? null,
                },
              },
            ),
          );
          return;
        }
        if (!respondUnavailableOnNodeInvokeError(respond, res)) {
          return;
        }
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      emitTalkPttNodeEvent({
        context,
        nodeId,
        command,
        payload,
      });
      respond(
        true,
        {
          ok: true,
          nodeId,
          command,
          payload,
          payloadJSON: res.payloadJSON ?? null,
        },
        undefined,
      );
    });
  },
  "node.invoke.result": handleNodeInvokeResult,
  "node.event": async ({ params, respond, context, client }) => {
    if (!validateNodeEventParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.event",
        validator: validateNodeEventParams,
      });
      return;
    }
    const p = params as { event: string; payload?: unknown; payloadJSON?: string | null };
    const payloadJSON =
      typeof p.payloadJSON === "string"
        ? p.payloadJSON
        : p.payload !== undefined
          ? JSON.stringify(p.payload)
          : null;
    await respondUnavailableOnThrow(respond, async () => {
      const { handleNodeEvent } = await import("../server-node-events.js");
      const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
      const nodeContext: NodeEventContext = {
        deps: context.deps,
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
        nodeSubscribe: context.nodeSubscribe,
        nodeUnsubscribe: context.nodeUnsubscribe,
        broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
        addChatRun: context.addChatRun,
        removeChatRun: context.removeChatRun,
        chatAbortControllers: context.chatAbortControllers,
        chatAbortedRuns: context.chatAbortedRuns,
        chatRunBuffers: context.chatRunBuffers,
        chatDeltaSentAt: context.chatDeltaSentAt,
        dedupe: context.dedupe,
        agentRunSeq: context.agentRunSeq,
        getHealthCache: context.getHealthCache,
        refreshHealthSnapshot: context.refreshHealthSnapshot,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        authorizeNodeSystemRunEvent: (eventParams) =>
          context.nodeRegistry.authorizeSystemRunEvent({
            nodeId: eventParams.nodeId,
            connId: eventParams.connId,
            runId: eventParams.runId,
            sessionKey: eventParams.sessionKey,
            terminal: eventParams.terminal,
          }),
        logGateway: { warn: context.logGateway.warn },
      };
      const result = await handleNodeEvent(
        nodeContext,
        nodeId,
        {
          event: p.event,
          payloadJSON,
        },
        { connId: client?.connId, deviceId: client?.connect?.device?.id },
      );
      respond(true, result ?? { ok: true }, undefined);
    });
  },
};

function buildNodeCommandRejectionHint(
  reason: string,
  command: string,
  node: { platform?: string } | undefined,
  cfg: OpenClawConfig,
): string {
  const platform = node?.platform ?? "unknown";
  if (reason === "command not declared by node") {
    return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
  }
  if (reason === "command not allowlisted") {
    if (command.startsWith("talk.")) {
      return `node command not allowed: "${command}" requires a trusted Talk-capable node`;
    }
    const denyCommands = cfg.gateway?.nodes?.denyCommands ?? [];
    if (denyCommands.some((entry) => entry.trim() === command)) {
      return `node command not allowed: "${command}" is blocked by gateway.nodes.denyCommands`;
    }
    if (DEFAULT_DANGEROUS_NODE_COMMANDS.includes(command)) {
      return `node command not allowed: "${command}" requires explicit gateway.nodes.allowCommands opt-in`;
    }
    return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
  }
  if (reason === "node did not declare commands") {
    return `node command not allowed: the node did not declare any supported commands`;
  }
  return `node command not allowed: ${reason}`;
}
