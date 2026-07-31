import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { shouldDowngradeDeliveryToSessionOnly } from "../../infra/outbound/best-effort-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { formatForLog } from "../ws-log.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type DeliveryPlan = Awaited<ReturnType<typeof resolveAgentDeliveryPlanWithSessionRoute>>;

export type AgentDeliveryPhaseResult = {
  activeSessionAgentId: string;
  deliveryPlan: DeliveryPlan;
  resolvedChannel: DeliveryPlan["resolvedChannel"];
  deliveryTargetMode: DeliveryPlan["deliveryTargetMode"];
  resolvedAccountId: DeliveryPlan["resolvedAccountId"];
  resolvedTo: DeliveryPlan["resolvedTo"];
  originMessageChannel: string;
  deliver: boolean;
  explicitThreadId?: string;
};

export async function resolveAgentDeliveryPhase(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  resolvedSessionAgentId?: string;
  agentId?: string;
  replyTo: string;
  to: string;
  recipientChannel?: string;
  recipientAccountId?: string;
  recipientThreadId?: string | number;
  bestEffortDeliver: boolean;
  runId: string;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
}): Promise<AgentDeliveryPhaseResult | undefined> {
  const activeSessionAgentId =
    params.resolvedSessionKey === "global" && params.resolvedSessionAgentId
      ? params.resolvedSessionAgentId
      : params.resolvedSessionKey
        ? resolveAgentIdFromSessionKey(params.resolvedSessionKey)
        : (params.agentId ?? resolveDefaultAgentId(params.cfgForAgent ?? params.cfg));

  const connId = typeof params.client?.connId === "string" ? params.client.connId : undefined;
  if (
    connId &&
    hasGatewayClientCap(params.client?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS)
  ) {
    params.context.registerToolEventRecipient(params.runId, connId);
    for (const [activeRunId, active] of params.context.chatAbortControllers) {
      const sameSession = active.sessionKey === params.resolvedSessionKey;
      const sameSelectedGlobalAgent =
        params.resolvedSessionKey === "global" ? active.agentId === activeSessionAgentId : true;
      if (activeRunId !== params.runId && sameSession && sameSelectedGlobalAgent) {
        params.context.registerToolEventRecipient(activeRunId, connId);
      }
    }
  }

  const wantsDelivery = params.request.deliver === true;
  const explicitThreadId = normalizeOptionalString(params.recipientThreadId);
  const turnSourceChannel = normalizeOptionalString(params.recipientChannel);
  const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: params.cfgForAgent ?? params.cfg,
    agentId: activeSessionAgentId,
    currentSessionKey: params.resolvedSessionKey,
    sessionEntry: params.sessionEntry,
    requestedChannel: params.request.replyChannel ?? params.recipientChannel,
    explicitTo: params.replyTo || params.to || undefined,
    explicitThreadId,
    accountId: params.request.replyAccountId ?? params.recipientAccountId,
    wantsDelivery,
    turnSourceChannel,
    turnSourceTo: params.to || undefined,
    turnSourceAccountId: normalizeOptionalString(params.recipientAccountId),
    turnSourceThreadId: explicitThreadId,
  });

  let resolvedChannel = deliveryPlan.resolvedChannel;
  let deliveryTargetMode = deliveryPlan.deliveryTargetMode;
  const resolvedAccountId = deliveryPlan.resolvedAccountId;
  let resolvedTo = deliveryPlan.resolvedTo;
  let effectivePlan = deliveryPlan;
  let deliveryDowngradeReason: string | null = null;
  let deliveryTargetResolutionError: Error | undefined = deliveryPlan.targetResolutionError;

  if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
    try {
      resolvedChannel = (
        await resolveMessageChannelSelection({ cfg: params.cfgForAgent ?? params.cfg })
      ).channel;
      deliveryTargetMode = deliveryTargetMode ?? "implicit";
      effectivePlan = {
        ...deliveryPlan,
        resolvedChannel,
        deliveryTargetMode,
        resolvedAccountId,
      };
    } catch (err) {
      if (
        !shouldDowngradeDeliveryToSessionOnly({
          wantsDelivery,
          bestEffortDeliver: params.bestEffortDeliver,
          resolvedChannel,
        })
      ) {
        params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return undefined;
      }
      deliveryDowngradeReason = String(err);
    }
  }

  if (wantsDelivery && deliveryTargetResolutionError) {
    if (!params.bestEffortDeliver) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String(deliveryTargetResolutionError)),
      );
      return undefined;
    }
    deliveryDowngradeReason = String(deliveryTargetResolutionError);
    resolvedChannel = INTERNAL_MESSAGE_CHANNEL;
    deliveryTargetMode = undefined;
    resolvedTo = undefined;
    effectivePlan = { ...deliveryPlan, resolvedChannel, resolvedTo, deliveryTargetMode };
  }

  if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
    const fallback = resolveAgentOutboundTarget({
      cfg: params.cfgForAgent ?? params.cfg,
      plan: effectivePlan,
      targetMode: deliveryTargetMode ?? "implicit",
      validateExplicitTarget: false,
    });
    if (fallback.resolvedTarget?.ok) {
      resolvedTo = fallback.resolvedTo;
    } else if (fallback.resolvedTarget && !fallback.resolvedTarget.ok) {
      deliveryTargetResolutionError = fallback.resolvedTarget.error;
    }
  }

  if (wantsDelivery && isDeliverableMessageChannel(resolvedChannel) && !resolvedTo) {
    if (!params.bestEffortDeliver) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          deliveryTargetResolutionError
            ? String(deliveryTargetResolutionError)
            : `delivery target is required for ${resolvedChannel}: pass --to/--reply-to or configure a default target`,
        ),
      );
      return undefined;
    }
    params.context.logGateway.info(
      deliveryTargetResolutionError
        ? `agent delivery target missing (bestEffortDeliver): ${String(deliveryTargetResolutionError)}`
        : "agent delivery target missing (bestEffortDeliver): no deliverable target",
    );
  }

  if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
    if (
      !shouldDowngradeDeliveryToSessionOnly({
        wantsDelivery,
        bestEffortDeliver: params.bestEffortDeliver,
        resolvedChannel,
      })
    ) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
        ),
      );
      return undefined;
    }
    params.context.logGateway.info(
      deliveryDowngradeReason
        ? `agent delivery downgraded to session-only (bestEffortDeliver): ${deliveryDowngradeReason}`
        : "agent delivery downgraded to session-only (bestEffortDeliver): no deliverable channel",
    );
  }

  const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
  const turnSourceMessageChannel =
    normalizedTurnSource &&
    (isGatewayMessageChannel(normalizedTurnSource) ||
      isInternalNonDeliveryChannel(normalizedTurnSource))
      ? normalizedTurnSource
      : undefined;
  return {
    activeSessionAgentId,
    deliveryPlan,
    resolvedChannel,
    deliveryTargetMode,
    resolvedAccountId,
    resolvedTo,
    originMessageChannel:
      turnSourceMessageChannel ??
      (params.client?.connect && params.isWebchatConnect(params.client.connect)
        ? INTERNAL_MESSAGE_CHANNEL
        : resolvedChannel),
    deliver: wantsDelivery && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL,
    explicitThreadId,
  };
}
