import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
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
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { errorShapeFromError } from "../error-shape.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

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
  client: AgentTurnPrincipal | null;
  context: AgentTurnContext;
  respond: GatewayRequestHandlerOptions["respond"];
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  onRunObserved?: (runId: string) => void;
}): Promise<AgentDeliveryPhaseResult | undefined> {
  const activeSessionAgentId = params.resolvedSessionAgentId
    ? params.resolvedSessionAgentId
    : params.resolvedSessionKey
      ? resolveAgentIdFromSessionKey(params.resolvedSessionKey, params.agentId)
      : params.agentId;
  if (!activeSessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agent selection is required for this session"),
    );
    return undefined;
  }

  if (params.onRunObserved) {
    params.onRunObserved(params.runId);
    const compatibilityOwnerAgentId = params.resolvedSessionKey
      ? tryResolveSessionCompatibilityOwnerAgentId(
          params.cfgForAgent ?? params.cfg,
          params.resolvedSessionKey,
        )
      : undefined;
    for (const [activeRunId, active] of params.context.chatAbortControllers) {
      const sameSession = active.sessionKey === params.resolvedSessionKey;
      const activeOwner = resolveChatRunOwnerAgentId({
        agentId: active.agentId,
        sessionKey: active.sessionKey,
        defaultAgentId: compatibilityOwnerAgentId,
      });
      if (activeRunId !== params.runId && sameSession && activeOwner === activeSessionAgentId) {
        params.onRunObserved(activeRunId);
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
  let deliveryResolutionError: string | null = null;
  let deliveryTargetResolutionError: Error | undefined = deliveryPlan.targetResolutionError;

  if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
    try {
      const selection = await resolveMessageChannelSelection({
        cfg: params.cfgForAgent ?? params.cfg,
      });
      resolvedChannel = selection.channel;
      deliveryTargetMode = deliveryTargetMode ?? "implicit";
      effectivePlan = {
        ...deliveryPlan,
        resolvedChannel,
        plugin: selection.plugin,
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
        params.respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
        return undefined;
      }
      deliveryResolutionError = String(err);
    }
  }

  if (wantsDelivery && deliveryTargetResolutionError && !params.bestEffortDeliver) {
    params.respond(
      false,
      undefined,
      errorShapeFromError(ErrorCodes.INVALID_REQUEST, deliveryTargetResolutionError),
    );
    return undefined;
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
        deliveryTargetResolutionError
          ? errorShapeFromError(ErrorCodes.INVALID_REQUEST, deliveryTargetResolutionError)
          : errorShape(
              ErrorCodes.INVALID_REQUEST,
              `delivery target is required for ${resolvedChannel}: pass --to/--reply-to or configure a default target`,
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
      deliveryResolutionError
        ? `agent delivery unresolved (bestEffortDeliver); final delivery will report: ${deliveryResolutionError}`
        : "agent delivery unresolved (bestEffortDeliver); final delivery will report: no deliverable channel",
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
    deliveryPlan: effectivePlan,
    resolvedChannel,
    deliveryTargetMode,
    resolvedAccountId,
    resolvedTo,
    originMessageChannel:
      turnSourceMessageChannel ??
      (params.client?.connect && params.isWebchatConnect(params.client.connect)
        ? INTERNAL_MESSAGE_CHANNEL
        : resolvedChannel),
    deliver: wantsDelivery,
    explicitThreadId,
  };
}
