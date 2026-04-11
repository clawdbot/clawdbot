import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  verifyNodeToken,
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
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  buildCanvasScopedHostUrl,
  CANVAS_CAPABILITY_TTL_MS,
  mintCanvasCapabilityToken,
} from "../canvas-capability.js";
import { createKnownNodeCatalog, getKnownNode, listKnownNodes } from "../node-catalog.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
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
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateNodeRenameParams,
} from "../protocol/index.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondInvalidParams,
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

export const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
export const NODE_WAKE_RECONNECT_POLL_MS = 150;
const NODE_WAKE_THROTTLE_MS = 15_000;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 60_000;
const NODE_PENDING_ACTION_TTL_MS = 10 * 60_000;
const NODE_PENDING_ACTION_MAX_PER_NODE = 64;

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

const nodeWakeById = new Map<string, NodeWakeState>();
const nodeWakeNudgeById = new Map<string, number>();

type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

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

async function resolveDirectNodePushConfig() {
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  return auth.ok
    ? { ok: true as const, auth: auth.value }
    : { ok: false as const, error: auth.error };
}

function resolveRelayNodePushConfig() {
  const relay = resolveApnsRelayConfigFromEnv(process.env, loadConfig().gateway);
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
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isForegroundRestrictedIosCommand(command: string): boolean {
  return (
    command === "canvas.present" ||
    command === "canvas.navigate" ||
    command.startsWith("canvas.") ||
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

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  client: { connect?: ConnectParams | null } | null;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions(params.nodeId);
  if (pending.length === 0) {
    return pending;
  }
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(loadConfig(), {
    platform: connect?.client?.platform,
    deviceFamily: connect?.client?.deviceFamily,
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

export async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: { force?: boolean; wakeReason?: string },
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
        return withDuration({ available: false, throttled: false, path: "no-registration" });
      }

      let wakeResult;
      if (registration.transport === "relay") {
        const relay = resolveRelayNodePushConfig();
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

export async function maybeSendNodeWakeNudge(nodeId: string): Promise<NodeWakeNudgeAttempt> {
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
      const relay = resolveRelayNodePushConfig();
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
  const timeoutMs = Math.max(250, params.timeoutMs ?? NODE_WAKE_RECONNECT_WAIT_MS);
  const pollMs = Math.max(50, params.pollMs ?? NODE_WAKE_RECONNECT_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.context.nodeRegistry.get(params.nodeId)) {
      return true;
    }
    await delayMs(pollMs);
  }
  return Boolean(params.context.nodeRegistry.get(params.nodeId));
}

/**
 * Remove cached wake/nudge state for a node that has disconnected.
 * Called from the WS close handler to prevent unbounded growth.
 */
export function clearNodeWakeState(nodeId: string): void {
  nodeWakeById.delete(nodeId);
  nodeWakeNudgeById.delete(nodeId);
}

export const nodeHandlers: GatewayRequestHandlers = {
  "node.pair.request": async ({ params, respond, context }) => {
    if (!validateNodePairRequestParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.request",
        validator: validateNodePairRequestParams,
      });
      return;
    }
    const p = params as Parameters<typeof requestNodePairing>[0];
    await respondUnavailableOnThrow(respond, async () => {
      const result = await requestNodePairing({
        nodeId: p.nodeId,
        displayName: p.displayName,
        platform: p.platform,
        version: p.version,
        coreVersion: p.coreVersion,
        uiVersion: p.uiVersion,
        deviceFamily: p.deviceFamily,
        modelIdentifier: p.modelIdentifier,
        caps: p.caps,
        commands: p.commands,
        permissions: p.permissions,
        remoteIp: p.remoteIp,
        silent: p.silent,
      });
      if (result.status === "pending" && result.created) {
        context.broadcast("node.pair.requested", result.request, {
          dropIfSlow: true,
        });
      }
      respond(true, result, undefined);
    });
  },
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
  "node.pair.verify": async ({ params, respond }) => {
    if (!validateNodePairVerifyParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.verify",
        validator: validateNodePairVerifyParams,
      });
      return;
    }
    const { nodeId, token } = params as {
      nodeId: string;
      token: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const result = await verifyNodeToken(nodeId, token);
      respond(true, result, undefined);
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
  "node.list": async ({ params, respond, context }) => {
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
      const catalog = createKnownNodeCatalog({
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        connectedNodes: context.nodeRegistry.listConnected(),
      });
      const nodes = listKnownNodes(catalog);
      respond(true, { ts: Date.now(), nodes }, undefined);
    });
  },
  "node.describe": async ({ params, respond, context }) => {
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
        connectedNodes: context.nodeRegistry.listConnected(),
      });
      const node = getKnownNode(catalog, id);
      if (!node) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { ts: Date.now(), ...node }, undefined);
    });
  },
  "node.canvas.capability.refresh": async ({ params, respond, client }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.canvas.capability.refresh",
        validator: validateNodeListParams,
      });
      return;
    }
    const baseCanvasHostUrl = normalizeOptionalString(client?.canvasHostUrl) ?? "";
    if (!baseCanvasHostUrl) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "canvas host unavailable for this node session"),
      );
      return;
    }

    const canvasCapability = mintCanvasCapabilityToken();
    const canvasCapabilityExpiresAtMs = Date.now() + CANVAS_CAPABILITY_TTL_MS;
    const scopedCanvasHostUrl = buildCanvasScopedHostUrl(baseCanvasHostUrl, canvasCapability);
    if (!scopedCanvasHostUrl) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to mint scoped canvas host URL"),
      );
      return;
    }

    if (client) {
      client.canvasCapability = canvasCapability;
      client.canvasCapabilityExpiresAtMs = canvasCapabilityExpiresAtMs;
    }
    respond(
      true,
      {
        canvasCapability,
        canvasCapabilityExpiresAtMs,
        canvasHostUrl: scopedCanvasHostUrl,
      },
      undefined,
    );
  },
  "node.pending.pull": async ({ params, respond, client }) => {
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

    const pending = resolveAllowedPendingNodeActions({ nodeId: trimmedNodeId, client });
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
    const ackIds = Array.from(
      new Set(
        (params.ids ?? []).map((value) => normalizeOptionalString(value) ?? "").filter(Boolean),
      ),
    );
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

    await respondUnavailableOnThrow(respond, async () => {
      let nodeSession = context.nodeRegistry.get(nodeId);
      if (!nodeSession) {
        const wakeReqId = req.id;
        const wakeFlowStartedAtMs = Date.now();
        context.logGateway.info(
          `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
        );

        const wake = await maybeWakeNodeWithApns(nodeId);
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
          const retryWake = await maybeWakeNodeWithApns(nodeId, { force: true });
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
          const nudge = await maybeSendNodeWakeNudge(nodeId);
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
      const cfg = loadConfig();
      const allowlist = resolveNodeCommandAllowlist(cfg, nodeSession);
      const allowed = isNodeCommandAllowed({
        command,
        declaredCommands: nodeSession.commands,
        allowlist,
      });
      if (!allowed.ok) {
        const hint = buildNodeCommandRejectionHint(allowed.reason, command, nodeSession);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, hint, {
            details: { reason: allowed.reason, command },
          }),
        );
        return;
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
      const res = await context.nodeRegistry.invoke({
        nodeId,
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
          const paramsJSON = toPendingParamsJSON(forwardedParams.params);
          const queued = enqueuePendingNodeAction({
            nodeId,
            command,
            paramsJSON,
            idempotencyKey: p.idempotencyKey,
          });
          const wake = await maybeWakeNodeWithApns(nodeId);
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
      const nodeContext = {
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
        logGateway: { warn: context.logGateway.warn },
      };
      await handleNodeEvent(nodeContext, nodeId, {
        event: p.event,
        payloadJSON,
      });
      respond(true, { ok: true }, undefined);
    });
  },
};

function buildNodeCommandRejectionHint(
  reason: string,
  command: string,
  node: { platform?: string } | undefined,
): string {
  const platform = node?.platform ?? "unknown";
  if (reason === "command not declared by node") {
    return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
  }
  if (reason === "command not allowlisted") {
    return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
  }
  if (reason === "node did not declare commands") {
    return `node command not allowed: the node did not declare any supported commands`;
  }
  return `node command not allowed: ${reason}`;
}
