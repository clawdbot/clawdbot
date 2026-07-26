import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentDeliveryPlanWithSessionRoute } from "../../infra/outbound/agent-delivery.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { loadSessionEntry } from "../session-utils.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

export async function runSessionResetFromAgent(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  creation: TrustedSessionCreation;
  assertCurrent?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
}) {
  const result = await performGatewaySessionReset({
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: params.reason,
    commandSource: "gateway:agent",
    creation: params.creation,
    assertCurrent: params.assertCurrent,
    onCommitted: params.onCommitted,
  });
  if (!result.ok) {
    return result;
  }
  if ("incognitoDeleted" in result) {
    return { ok: true as const, key: result.key };
  }
  return {
    ok: true as const,
    key: result.key,
    sessionId: result.entry.sessionId,
  };
}

export function sessionResetAckText(reason: "new" | "reset"): string {
  return reason === "new" ? "✅ New session started." : "✅ Session reset.";
}

export function buildBareSessionResetResult(params: {
  reason: "new" | "reset";
  sessionId?: string;
  ackText?: string;
}) {
  return {
    payloads: [{ text: params.ackText ?? sessionResetAckText(params.reason) }],
    meta: {
      durationMs: 0,
      ...(params.sessionId
        ? {
            agentMeta: {
              sessionId: params.sessionId,
            },
          }
        : {}),
    },
  };
}

export function buildBareSessionResetResponse(params: {
  runId: string;
  result:
    | ReturnType<typeof buildBareSessionResetResult>
    | Awaited<ReturnType<typeof agentCommandFromIngress>>;
}) {
  return {
    runId: params.runId,
    status: "ok" as const,
    summary: "completed",
    result: params.result,
  };
}

async function deliverBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: {
    replyTo?: string;
    to?: string;
    replyChannel?: string;
    channel?: string;
    replyAccountId?: string;
    accountId?: string;
    threadId?: string | number;
    bestEffortDeliver?: boolean;
  };
  bestEffortDeliver?: boolean;
  deliveryTargetMode?: AgentCommandOpts["deliveryTargetMode"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  const { deliverAgentCommandResult } = await import("../../agents/command/delivery.runtime.js");
  params.assertCurrent?.();
  const result = buildBareSessionResetResult({
    reason: params.reason,
    sessionId: params.sessionId,
    ackText: params.ackText,
  });
  return await deliverAgentCommandResult({
    cfg: params.cfg,
    deps: params.context.deps,
    runtime: defaultRuntime,
    opts: {
      message: params.ackText ?? sessionResetAckText(params.reason),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      sessionKey: params.sessionKey,
      deliver: true,
      replyTo: params.request.replyTo,
      to: params.request.to,
      replyChannel: params.request.replyChannel,
      channel: params.request.channel,
      replyAccountId: params.request.replyAccountId,
      accountId: params.request.accountId,
      threadId: params.request.threadId,
      deliveryTargetMode: params.deliveryTargetMode,
      bestEffortDeliver: params.bestEffortDeliver,
      runId: params.runId,
      messageChannel: params.originMessageChannel,
      runContext: {
        messageChannel: params.originMessageChannel,
        accountId: params.request.replyAccountId ?? params.request.accountId,
        currentThreadTs:
          params.request.threadId != null ? String(params.request.threadId) : undefined,
      },
      allowModelOverride: false,
    },
    outboundSession: undefined,
    sessionEntry: params.sessionEntry,
    result: result as never,
    payloads: result.payloads as never,
    assertDeliveryCurrent: params.assertCurrent,
  });
}

export async function resolveBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: Parameters<GatewayRequestHandlers["agent"]>[0]["params"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  params.assertCurrent?.();
  if (params.request.deliver !== true) {
    return buildBareSessionResetResult({
      reason: params.reason,
      sessionId: params.sessionId,
      ackText: params.ackText,
    });
  }
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: sessionDeliveryChannel(params.sessionEntry),
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    throw new Error("send blocked by session policy");
  }
  const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    currentSessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    requestedChannel:
      normalizeOptionalString(params.request.replyChannel) ??
      normalizeOptionalString(params.request.channel),
    explicitTo:
      normalizeOptionalString(params.request.replyTo) ?? normalizeOptionalString(params.request.to),
    explicitThreadId: normalizeOptionalString(params.request.threadId),
    accountId:
      normalizeOptionalString(params.request.replyAccountId) ??
      normalizeOptionalString(params.request.accountId),
    wantsDelivery: true,
    turnSourceChannel: normalizeOptionalString(params.request.channel),
    turnSourceTo: normalizeOptionalString(params.request.to),
    turnSourceAccountId: normalizeOptionalString(params.request.accountId),
    turnSourceThreadId: normalizeOptionalString(params.request.threadId),
  });
  params.assertCurrent?.();
  const mainSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
  });
  // Main/global resets default to best-effort delivery because no caller session may remain.
  const bestEffortDeliver =
    typeof params.request.bestEffortDeliver === "boolean"
      ? params.request.bestEffortDeliver
      : params.sessionKey === mainSessionKey || params.sessionKey === "global"
        ? true
        : undefined;
  return await deliverBareSessionResetResult({
    cfg: params.cfg,
    context: params.context,
    reason: params.reason,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    request: {
      ...params.request,
      channel: deliveryPlan.resolvedChannel,
      to: deliveryPlan.resolvedTo ?? deliveryPlan.baseDelivery.to,
      accountId: deliveryPlan.resolvedAccountId ?? deliveryPlan.baseDelivery.accountId,
      threadId: deliveryPlan.resolvedThreadId,
    },
    bestEffortDeliver,
    deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? deliveryPlan.baseDelivery.mode,
    originMessageChannel: params.originMessageChannel ?? deliveryPlan.resolvedChannel,
    runId: params.runId,
    assertCurrent: params.assertCurrent,
    ackText: params.ackText,
  });
}

export function loadBareSessionResetDeliverySession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
} {
  const selectedGlobalAgentId =
    params.sessionKey === "global" && params.agentId ? params.agentId : undefined;
  const loaded = loadSessionEntry(params.sessionKey, {
    clone: false,
    ...(selectedGlobalAgentId ? { agentId: selectedGlobalAgentId } : {}),
  });
  const loadedCfg = loaded?.cfg ?? params.cfg;
  return {
    cfg: loadedCfg,
    entry: loaded?.entry,
    agentId:
      selectedGlobalAgentId ??
      resolveAgentIdFromSessionKey(params.sessionKey) ??
      resolveDefaultAgentId(loadedCfg),
  };
}

export function resolveSessionRuntimeCwd(params: {
  requestedCwd?: string;
  sessionEntry?: SessionEntry;
}): string | undefined {
  return normalizeOptionalString(params.requestedCwd ?? params.sessionEntry?.spawnedCwd);
}
