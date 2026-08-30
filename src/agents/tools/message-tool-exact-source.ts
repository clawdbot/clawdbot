import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  selectMessageActionRequesterIdentity,
  type AgentRuntimeMessageActionContext,
} from "../../gateway/message-action-turn-capability.js";
import type { MessageActionInput } from "../../infra/outbound/message-action-contracts.js";
import { prepareInternalSourceReplyPayload } from "../../infra/outbound/message-action-runner.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { textResult } from "./common.js";
import type { MessageToolOptions } from "./message-tool-options.js";

export async function prepareDeferredExactSourceReply(params: {
  options?: MessageToolOptions;
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  accountId?: string;
  turnContext?: AgentRuntimeMessageActionContext;
  toolContext?: MessageActionInput["toolContext"];
  runId?: string;
  executionIdentityToken?: MessageActionInput["executionIdentityToken"];
  agentId?: string;
  workspaceMediaAccess?: MessageActionInput["workspaceMediaAccess"];
  sourceReplyDeliveryMode?: MessageActionInput["sourceReplyDeliveryMode"];
  sourceChannel?: string | null;
  requestedFinal?: boolean;
  abortSignal?: AbortSignal;
}) {
  if (params.requestedFinal === false) {
    return textResult(
      "Skipped the non-final current-source progress send. Continue the run and provide the completed answer normally.",
      {
        status: "suppressed",
        deliveryStatus: "suppressed",
        reason: "source_progress_host_final_unsupported",
        sourceReplySink: "host-final" as const,
      },
    );
  }
  const prepared = await prepareInternalSourceReplyPayload(
    {
      cfg: params.cfg,
      action: "send",
      params: params.actionParams,
      actionOrigin: "message-tool",
      defaultAccountId: params.accountId,
      ...selectMessageActionRequesterIdentity(params.turnContext),
      messageActionAuthorization: {
        requesterAccountId: params.turnContext?.requesterAccountId,
        requesterSenderId: params.turnContext?.requesterSenderId,
        toolContext: params.turnContext?.toolContext,
      },
      senderIsOwner: params.options?.senderIsOwner,
      conversationReadOrigin: params.options?.conversationReadOrigin,
      workspaceDir: params.options?.workspaceDir,
      toolContext: params.toolContext,
      sessionKey: params.options?.agentSessionKey,
      sourceReplySessionKey: params.options?.runSessionKey,
      sessionId: params.options?.sessionId,
      runId: params.runId,
      executionIdentityToken: params.executionIdentityToken,
      agentId: params.agentId,
      workspaceMediaAccess: params.workspaceMediaAccess,
      sandboxRoot: params.options?.sandboxRoot,
      sandboxContainerWorkdir: params.options?.sandboxContainerWorkdir,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      inboundEventKind: params.options?.inboundEventKind,
      inboundAudio:
        params.options?.hasCurrentInboundAudio?.() ?? params.options?.currentInboundAudio,
      abortSignal: params.abortSignal,
    },
    params.actionParams,
    {
      channel: normalizeMessageChannel(params.sourceChannel) ?? INTERNAL_MESSAGE_CHANNEL,
      accountId: params.accountId,
    },
  );
  const details = {
    status: "deferred",
    deliveryStatus: "deferred",
    reason: "source_final_delivery_deferred",
    sourceReplySink: "host-final" as const,
    hostFinalDeferred: true as const,
    sourceReply: prepared.payload,
    ...(prepared.message ? { message: prepared.message } : {}),
    ...(prepared.mediaUrls[0] ? { mediaUrl: prepared.mediaUrls[0] } : {}),
    ...(prepared.mediaUrls.length ? { mediaUrls: prepared.mediaUrls } : {}),
  };
  return textResult(
    "Prepared the current-source reply for automatic host delivery. Do not retry it with the message tool.",
    details,
  );
}

export function resolveTrustedDecisionChannel(
  raw: string | null | undefined,
  catalog: PreparedMessageToolCatalog | undefined,
): string | undefined {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return undefined;
  }
  return channel === INTERNAL_MESSAGE_CHANNEL || catalog?.getChannel(channel) ? channel : undefined;
}

export function resolvesToDeferredExactSource(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  sourceAccountId?: string;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
}): boolean {
  if (params.action !== "send" && params.action !== "reply") {
    return false;
  }
  if (params.args.dryRun === true) {
    return false;
  }
  const sourceChannel = normalizeMessageChannel(params.currentChannelProvider);
  const channel = normalizeMessageChannel(params.channel);
  if (!sourceChannel || channel !== sourceChannel) {
    return false;
  }

  const requestedAccountId = normalizeAccountId(params.accountId ?? "default");
  const sourceAccountId = normalizeAccountId(params.sourceAccountId ?? "default");
  if (requestedAccountId !== sourceAccountId) {
    return false;
  }

  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return false;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return false;
  }
  const target = targets[0];
  if (target) {
    const toolContext = {
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentChannelProvider: sourceChannel,
      currentThreadTs: params.currentThreadTs,
    };
    const matchesCurrentTarget =
      getChannelPlugin(channel)?.threading?.matchesToolContextTarget?.({
        target,
        toolContext,
      }) === true ||
      target === params.currentChannelId ||
      target === params.currentMessagingTarget;
    if (!matchesCurrentTarget) {
      return false;
    }
  }

  const sourceThreadId = normalizeOptionalStringifiedId(params.currentThreadTs);
  const explicitThreadId = normalizeOptionalStringifiedId(params.args.threadId);
  const suppressesImplicitThread = params.args.topLevel === true || params.args.threadId === null;
  const effectiveThreadId =
    explicitThreadId ?? (suppressesImplicitThread ? undefined : sourceThreadId);
  return effectiveThreadId === sourceThreadId;
}
