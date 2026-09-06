import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "./attempt-tool-construction-plan.js";
import type { EmbeddedRunTrigger, RunEmbeddedAgentParams } from "./params.js";

type AttemptToolRunFacts = Pick<
  RunEmbeddedAgentParams,
  | "clientCaps"
  | "pinnedWidgetAuthoring"
  | "toolBindings"
  | "chatType"
  | "agentAccountId"
  | "messageTo"
  | "messageThreadId"
  | "chatId"
  | "messageActionTurnCapability"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "spawnedBy"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "scheduledToolPolicy"
  | "approvalReviewerDeviceId"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "currentThreadTs"
  | "currentMessageId"
  | "replyToMode"
  | "hasRepliedRef"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
>;

/**
 * Builds the shared tool-run context for embedded and plugin harness attempts.
 */
export function buildEmbeddedAttemptToolRunContext(
  params: AttemptToolRunFacts & {
    thinkLevel?: ThinkLevel;
    trigger?: EmbeddedRunTrigger;
    jobId?: string;
    memoryFlushWritePath?: string;
    toolsAllow?: string[];
    forceMessageTool?: boolean;
    swarmCollector?: boolean;
    swarmOutputSchema?: Record<string, unknown>;
    conversationToolPolicy?: GroupToolPolicyConfig;
    trace?: DiagnosticTraceContext;
    currentInboundAudio?: boolean;
    replyOperation?: { readonly acceptedSteeredInboundAudio: boolean };
  },
) {
  const { currentInboundAudio, replyOperation } = params;
  // Collector output is mandatory result transport, even on a narrowed tool surface.
  const runtimeToolAllowlist = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
    forceToolNames:
      params.swarmCollector && params.swarmOutputSchema ? ["structured_output"] : undefined,
  });
  return {
    clientCaps: params.clientCaps,
    pinnedWidgetAuthoring: params.pinnedWidgetAuthoring,
    toolBindings: params.toolBindings,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    nativeChannelId: params.chatId,
    messageActionTurnCapability: params.messageActionTurnCapability,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    scheduledToolPolicy: params.scheduledToolPolicy,
    approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    requesterThinkingLevel: params.thinkLevel,
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    currentInboundAudio,
    // Read accepted steering from the captured owner when the tool executes.
    hasCurrentInboundAudio: () =>
      currentInboundAudio === true || replyOperation?.acceptedSteeredInboundAudio === true,
    ...(runtimeToolAllowlist ? { runtimeToolAllowlist } : {}),
    ...(params.conversationToolPolicy
      ? { conversationToolPolicy: params.conversationToolPolicy }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}
