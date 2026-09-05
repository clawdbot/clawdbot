import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { readEmbeddedMessageDeliveryFact } from "../../embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  resolveMessageToolSourceReplyFinal,
} from "../../embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  isDeliveredMessagingToolSendToCurrentSource,
} from "../../embedded-agent-messaging-extraction.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { readToolResultDetails } from "../../tool-result-error.js";

type MessageToolTerminalRoute = Omit<
  Parameters<typeof isDeliveredMessagingToolSendToCurrentSource>[0],
  "send" | "deliveredPayload"
> & {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

/** Detects message-tool-only sends that delivered a visible current-source reply. */
function isDeliveredMessageToolOnlySourceReply(
  params: MessageToolTerminalRoute & {
    context: AfterToolCallContext;
    hookResult?: AfterToolCallResult;
  },
): boolean {
  const toolName = params.context.toolCall.name;
  const toolArgs = argsRecordForToolCall(params.context);
  const extractionArgs =
    toolName === "message" &&
    params.currentProvider &&
    typeof toolArgs.provider !== "string" &&
    typeof toolArgs.channel !== "string"
      ? { ...toolArgs, provider: params.currentProvider }
      : toolArgs;
  const pendingSend = extractMessagingToolSend(toolName, extractionArgs, {
    config: params.config,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadId: params.currentThreadId,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
  });
  const confirmedSend =
    pendingSend && extractMessagingToolSendResult(pendingSend, params.context.result);
  const deliveryFact = readEmbeddedMessageDeliveryFact(
    readToolResultDetails(params.context.result)?.messageDelivery,
  );
  const isError = params.hookResult?.isError ?? params.context.isError;
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName,
    args: toolArgs,
    result: params.hookResult ?? params.context.result,
    // Middleware may retain a delivery summary while redacting its source receipt.
    hookResult: params.context.result,
    isError,
    allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
      send: confirmedSend,
      config: params.config,
      currentProvider: params.currentProvider,
      currentAccountId: params.currentAccountId,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadId: params.currentThreadId,
      sessionKey: params.sessionKey,
      deliveredPayload: params.context.result,
    }),
    ...(deliveryFact
      ? {
          deliveryConfirmed:
            deliveryFact.status === "settled" && (!isError || deliveryFact.partialDelivery),
        }
      : {}),
  });
}

export function installMessageToolOnlyTerminalHook(
  params: MessageToolTerminalRoute & {
    agent: Agent;
    onDeliveredSourceReply?: () => void;
  },
): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (
      isDeliveredMessageToolOnlySourceReply({
        ...params,
        context,
        hookResult,
      })
    ) {
      params.onDeliveredSourceReply?.();
      if (resolveMessageToolSourceReplyFinal(argsRecordForToolCall(context))) {
        return { ...hookResult, terminate: true };
      }
    }
    return hookResult;
  };
}
