import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import {
  actionRequiresTarget,
  resolveActionDeliveryTargetAlias,
} from "../../infra/outbound/message-action-spec.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { asToolParamsRecord, type AnyAgentTool, readToolStringParam } from "./common.js";
import { createMessageToolDecisionRecorder } from "./message-tool-decision.js";

type ExplicitMessageTargetContext = {
  currentChannelProvider?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type ExplicitMessageTargetGuard = {
  prepareBeforeToolCallParams: NonNullable<AnyAgentTool["prepareBeforeToolCallParams"]>;
  finalizeBeforeToolCallParams: NonNullable<AnyAgentTool["finalizeBeforeToolCallParams"]>;
  require(params: Record<string, unknown>, action: ChannelMessageActionName): void;
};

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return action === "broadcast" || actionRequiresTarget(action);
}

function requireExplicitMessageTarget(
  params: Record<string, unknown>,
  action: ChannelMessageActionName,
  context: ExplicitMessageTargetContext,
): void {
  if (!actionNeedsExplicitTarget(action)) {
    return;
  }
  const hasCanonicalTarget =
    (typeof params.target === "string" && params.target.trim().length > 0) ||
    (typeof params.to === "string" && params.to.trim().length > 0) ||
    (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
  if (hasCanonicalTarget) {
    return;
  }
  const channel =
    normalizeMessageChannel(normalizeOptionalString(params.channel)) ??
    normalizeMessageChannel(context.currentChannelProvider);
  const aliasSpec = channel
    ? context.preparedMessageToolCatalog?.getChannel(channel)?.actions
        ?.messageActionTargetAliases?.[action]
    : undefined;
  if (
    channel &&
    aliasSpec &&
    resolveActionDeliveryTargetAlias(action, params, { channel, aliasSpec })
  ) {
    return;
  }
  throw new MessageActionDeniedError(
    "Explicit message target required for this run. Provide target/targets (and channel when needed).",
    "message_target_missing",
    "message-target:explicit",
  );
}

export function createMessageToolExplicitTargetGuard(params: {
  currentChannelProvider?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
  decisionChannel?: string;
}): ExplicitMessageTargetGuard {
  const toolCallIds = new WeakMap<object, string>();
  const context: ExplicitMessageTargetContext = {
    currentChannelProvider: params.currentChannelProvider,
    preparedMessageToolCatalog: params.preparedMessageToolCatalog,
  };
  const requireTarget = (actionParams: Record<string, unknown>, action: ChannelMessageActionName) =>
    requireExplicitMessageTarget(actionParams, action, context);

  return {
    prepareBeforeToolCallParams(rawParams, hookContext) {
      if (rawParams && typeof rawParams === "object" && hookContext.toolCallId) {
        toolCallIds.set(rawParams, hookContext.toolCallId);
      }
      return rawParams;
    },
    finalizeBeforeToolCallParams(rawParams, preparedParams) {
      const actionParams = asToolParamsRecord(rawParams);
      const actionId =
        preparedParams && typeof preparedParams === "object"
          ? toolCallIds.get(preparedParams)
          : undefined;
      const action = readToolStringParam(actionParams, "action", {
        required: true,
      }) as ChannelMessageActionName; // SAFETY: the message tool schema owns this closed vocabulary.
      if (!actionId) {
        requireTarget(actionParams, action);
        return rawParams;
      }
      createMessageToolDecisionRecorder({
        actionId,
        action,
        channel: params.decisionChannel,
      }).runBoundary(() => requireTarget(actionParams, action));
      return rawParams;
    },
    require: requireTarget,
  };
}
