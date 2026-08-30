import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { readToolStringParam } from "../../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { MessageActionInput, MessageActionNormalization } from "./message-action-contracts.js";
import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  parseInteractiveParam,
  parseJsonMessageParam,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";
import { buildMessagePayload } from "./message-action-send.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./message-action-tts.js";
import { sourceDeliveryTargetsMatch } from "./source-delivery-plan.js";

export type PreparedInternalSourceReplyPayload = {
  payload: ReplyPayload;
  message: string;
  mediaUrls: string[];
  normalization?: MessageActionNormalization;
};

/**
 * Canonicalizes and stages a current-source reply without recording or
 * performing delivery. Callers that defer transport to the host use this same
 * path as the internal source sink so text, rich content, and attachments do
 * not drift between the two ownership modes.
 */
export async function prepareInternalSourceReplyPayload(
  input: MessageActionInput,
  params: Record<string, unknown>,
  route?: { channel: ChannelId; accountId?: string | null },
): Promise<PreparedInternalSourceReplyPayload> {
  throwIfAborted(input.abortSignal);
  parseJsonMessageParam(params, "presentation");
  parseJsonMessageParam(params, "delivery");
  parseInteractiveParam(params);
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const agentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: input.cfg })
      : undefined);
  const mediaAccess =
    input.mediaAccess ??
    resolveAgentScopedOutboundMediaAccess({
      cfg: input.cfg,
      agentId,
      workspaceDir: input.workspaceDir,
      mediaSources: collectActionMediaSourceHints(params, [], { structuredAttachments: "all" }),
      workspaceMediaAccess: input.workspaceMediaAccess,
      sessionKey: input.sessionKey,
      messageProvider: input.sessionKey ? undefined : INTERNAL_MESSAGE_CHANNEL,
      accountId: input.sessionKey ? input.requesterAccountId : undefined,
      requesterSenderId: input.requesterSenderId,
      requesterSenderName: input.requesterSenderName,
      requesterSenderUsername: input.requesterSenderUsername,
      requesterSenderE164: input.requesterSenderE164,
    });
  const sandboxMediaReadFile = input.workspaceMediaAccess?.readFile
    ? mediaAccess.readFile
    : undefined;
  await hydrateAttachmentParamsForAction({
    cfg: input.cfg,
    channel: INTERNAL_MESSAGE_CHANNEL,
    args: params,
    action: "send",
    dryRun,
    mediaPolicy: resolveAttachmentMediaPolicy({
      sandboxRoot: input.sandboxRoot,
      sandboxContainerWorkdir: input.sandboxContainerWorkdir,
      mediaAccess,
      mediaReadFile: sandboxMediaReadFile,
    }),
  });
  const sourceReply = await buildMessagePayload({
    cfg: input.cfg,
    actionParams: params,
    input,
    agentId,
  });
  let sourceReplyPayload = sourceReply.payload;
  // Explicit message-tool speech lives in WeakMap metadata and cannot survive
  // embedded/CLI carrier serialization. Materialize it while that metadata is
  // still present; automatic host TTS remains owned by ordinary final dispatch.
  if (route && getReplyPayloadMetadata(sourceReplyPayload)?.ttsExplicit === true) {
    sourceReplyPayload = await maybeApplyTtsToMessageActionSendPayload({
      payload: sourceReplyPayload,
      cfg: input.cfg,
      channel: route.channel,
      accountId: route.accountId,
      agentId,
      sessionKey: input.sessionKey,
      inboundAudio: input.inboundAudio,
      dryRun,
    });
  }
  const explicitReplyToId = readToolStringParam(params, "replyTo");
  if (explicitReplyToId) {
    sourceReplyPayload = {
      ...sourceReplyPayload,
      replyToId: explicitReplyToId,
      replyToIdSource: "explicit",
    };
  }
  const requestedMediaCount =
    resolveSendableOutboundReplyParts(sourceReplyPayload).mediaUrls.length;
  if (!dryRun && requestedMediaCount > 0) {
    const workspaceDir =
      input.workspaceDir ??
      mediaAccess.workspaceDir ??
      (agentId ? resolveAgentWorkspaceDir(input.cfg, agentId) : undefined);
    if (!workspaceDir) {
      throw new Error("Current-source media requires an agent workspace.");
    }
    const { createReplyMediaPathNormalizer } =
      await import("../../auto-reply/reply/reply-media-paths.runtime.js");
    sourceReplyPayload = await createReplyMediaPathNormalizer({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
      agentId,
      workspaceDir,
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      requesterSenderId: input.requesterSenderId ?? undefined,
      requesterSenderName: input.requesterSenderName ?? undefined,
      requesterSenderUsername: input.requesterSenderUsername ?? undefined,
      requesterSenderE164: input.requesterSenderE164 ?? undefined,
      mediaAccess,
      sandboxRoot: input.sandboxRoot,
      sandboxContainerWorkdir: input.sandboxContainerWorkdir,
    })(sourceReplyPayload);
    if (
      resolveSendableOutboundReplyParts(sourceReplyPayload).mediaUrls.length !== requestedMediaCount
    ) {
      throw new Error(
        "Current-source media could not be staged. Use an accessible URL, a file inside the agent workspace, or the buffer field.",
      );
    }
  }
  const sourceReplyMediaUrls = resolveSendableOutboundReplyParts(sourceReplyPayload).mediaUrls;
  const sourceReplyMessage = sourceReplyPayload.text ?? sourceReply.message;
  return {
    payload: sourceReplyPayload,
    message: sourceReplyMessage,
    mediaUrls: sourceReplyMediaUrls,
    ...(sourceReply.normalization ? { normalization: sourceReply.normalization } : {}),
  };
}

export function buildInternalSourceReplyToolResult(payload: {
  status: string;
  deliveryStatus: string;
  channel: ChannelId;
  target: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  idempotencyKey?: string;
  sourceReplyTranscriptOwner?: true;
  sourceReplySink?: "internal-ui";
  sourceReply: ReplyPayload;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  dryRun: boolean;
}): AgentToolResult<{
  status: string;
  deliveryStatus: string;
  channel: ChannelId;
  target: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  idempotencyKey?: string;
  sourceReplyTranscriptOwner?: true;
  sourceReplySink?: "internal-ui";
  sourceReply: ReplyPayload;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  dryRun: boolean;
}> {
  const action = payload.dryRun ? "Prepared" : "Sent";
  const sink = payload.sourceReplySink ? ` via ${payload.sourceReplySink}` : "";
  return {
    content: [
      {
        type: "text",
        text: `${action} visible reply to the current source conversation${sink}.`,
      },
    ],
    details: {
      status: payload.status,
      deliveryStatus: payload.deliveryStatus,
      channel: payload.channel,
      target: payload.target,
      ...(payload.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: payload.sourceReplyDeliveryMode }
        : {}),
      ...(payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : {}),
      ...(payload.sourceReplyTranscriptOwner ? { sourceReplyTranscriptOwner: true as const } : {}),
      ...(payload.sourceReplySink ? { sourceReplySink: payload.sourceReplySink } : {}),
      sourceReply: payload.sourceReply,
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
      ...(payload.mediaUrls?.length ? { mediaUrls: payload.mediaUrls } : {}),
      dryRun: payload.dryRun,
    },
  };
}

export function resolvesToCurrentSourceRoute(params: {
  input: MessageActionInput;
  actionParams: Record<string, unknown>;
  channel: ChannelId;
  accountId?: string | null;
  dryRun: boolean;
}): boolean {
  if (params.input.deferSourceMessageToolDelivery !== true || params.dryRun) {
    return false;
  }
  const sourceContext =
    params.input.messageActionAuthorization?.toolContext ?? params.input.toolContext;
  const sourceChannel = normalizeMessageChannel(sourceContext?.currentChannelProvider);
  if (!sourceChannel || sourceChannel !== params.channel) {
    return false;
  }
  const sourceAccountId =
    params.input.messageActionAuthorization?.requesterAccountId ??
    params.input.requesterAccountId ??
    params.input.defaultAccountId;
  if (normalizeAccountId(params.accountId) !== normalizeAccountId(sourceAccountId)) {
    return false;
  }
  const target =
    readToolStringParam(params.actionParams, "to") ??
    readToolStringParam(params.actionParams, "target") ??
    readToolStringParam(params.actionParams, "channelId");
  if (!target) {
    return false;
  }
  const explicitThreadId = stringifyRouteThreadId(params.actionParams.threadId);
  const threadSuppressed =
    params.actionParams.topLevel === true || params.actionParams.threadId === null;
  const sourceTargets = [
    normalizeOptionalString(sourceContext?.currentMessagingTarget),
    normalizeOptionalString(sourceContext?.currentChannelId),
  ].filter((value): value is string => Boolean(value));
  return sourceTargets.some((sourceTarget) =>
    sourceDeliveryTargetsMatch(
      {
        tool: "message",
        provider: params.channel,
        accountId: normalizeAccountId(params.accountId),
        to: target,
        ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
        ...(!explicitThreadId ? { threadImplicit: !threadSuppressed } : {}),
        ...(threadSuppressed ? { threadSuppressed: true } : {}),
      },
      {
        channel: sourceChannel,
        accountId: normalizeAccountId(sourceAccountId),
        to: sourceTarget,
        threadId: sourceContext?.currentThreadTs,
      },
    ),
  );
}
