// Stable facade for message-action normalization, routing, and execution.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { readStringArrayParam, readToolStringParam } from "../../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { hasPollCreationParams } from "../../poll-params.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import { shouldUseInternalSourceReplySink } from "./internal-source-reply.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";
import type {
  MessageActionInput,
  MessageActionNormalization,
  MessageActionResult,
  ResolvedActionContext,
} from "./message-action-contracts.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { executeMessagePlugin, executeMessagePoll } from "./message-action-execution.js";
import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
  parseInteractiveParam,
  parseJsonMessageParam,
  resolveAttachmentMediaPolicy,
  resolveExtraActionMediaSourceParamKeys,
} from "./message-action-params.js";
import { prepareMessageRoute, resolveMessageTarget } from "./message-action-routing.js";
import { buildMessagePayload, executeMessageSend } from "./message-action-send.js";
import type { MessageSendResult } from "./message.js";
import {
  enforceMessageActionAllowlist,
  resolveEffectiveMessageToolsConfig,
} from "./outbound-policy.js";

export function getToolResult(result: MessageActionResult): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function withSendNormalization(
  result: MessageActionResult,
  normalization?: MessageActionNormalization,
): MessageActionResult {
  return normalization && result.kind === "send" ? { ...result, normalization } : result;
}

function deriveBroadcastEntryOutcome(
  sendResult?: MessageSendResult,
): { ok: true } | { ok: false; error: string; sentBeforeError?: true } {
  if (
    !sendResult ||
    sendResult.deliveryStatus === undefined ||
    sendResult.deliveryStatus === "sent"
  ) {
    return { ok: true };
  }
  switch (sendResult.deliveryStatus) {
    case "suppressed":
      return {
        ok: false,
        error: `Broadcast send suppressed: ${sendResult.suppressionReason ?? "unknown reason"}.`,
      };
    case "failed":
      return { ok: false, error: sendResult.error ?? "Broadcast send failed." };
    case "partial_failed":
      return {
        ok: false,
        error: sendResult.error ?? "Broadcast send partially failed.",
        sentBeforeError: true,
      };
  }
  return sendResult.deliveryStatus satisfies never;
}

async function handleBroadcastAction(
  input: MessageActionInput,
  params: Record<string, unknown>,
): Promise<MessageActionResult> {
  throwIfAborted(input.abortSignal);
  const broadcastEnabled =
    resolveEffectiveMessageToolsConfig({ cfg: input.cfg, agentId: input.agentId })?.broadcast
      ?.enabled !== false;
  if (!broadcastEnabled) {
    throw new MessageActionDeniedError(
      "Broadcast is disabled. Set tools.message.broadcast.enabled to true.",
      "message_broadcast_disabled",
      "message-broadcast:enabled",
    );
  }
  const rawTargets = readStringArrayParam(params, "targets", { required: true });
  if (rawTargets.length === 0) {
    throw new Error("Broadcast requires at least one target in --targets.");
  }
  const channelHint = readToolStringParam(params, "channel");
  const explicitAccountId = validateExplicitMessageAccountSelection({
    cfg: input.cfg,
    accountId: readToolStringParam(params, "accountId"),
    checkResolvedAccount: false,
  });
  if (input.broadcastAccountPlan && input.broadcastAccountPlan.accountId !== explicitAccountId) {
    throw new Error("Broadcast account plan does not match the requested account.");
  }
  const targetChannels =
    channelHint && normalizeOptionalLowercaseString(channelHint) !== "all"
      ? [
          (
            await resolveMessageChannelSelection({
              cfg: input.cfg,
              channel: channelHint,
              fallbackChannel: input.toolContext?.currentChannelProvider,
              agentId: input.agentId,
            })
          ).channel,
        ]
      : input.broadcastAccountPlan
        ? input.broadcastAccountPlan.candidateChannels
        : await (async () => {
            const configured = await listConfiguredMessageChannels(input.cfg);
            if (configured.length === 0) {
              throw new Error("Broadcast requires at least one configured channel.");
            }
            return configured;
          })();
  if (targetChannels.length === 0) {
    throw new Error("Broadcast requires at least one configured channel.");
  }
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    sentBeforeError?: true;
    payload?: unknown;
    result?: MessageSendResult;
  }> = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  let attemptIndex = 0;
  for (const targetChannel of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      const receiptDiscriminator = `broadcast:${attemptIndex++}`;
      try {
        const targetAccountId = validateExplicitMessageAccountSelection({
          cfg: input.cfg,
          channel: targetChannel,
          accountId: explicitAccountId,
        });
        const targetArgs: Record<string, unknown> = { to: target };
        const resolved = await resolveMessageTarget({
          cfg: input.cfg,
          channel: targetChannel,
          action: "send",
          args: targetArgs,
          accountId: targetAccountId,
        });
        if (!resolved) {
          throw new Error("Broadcast target resolution unexpectedly deferred.");
        }
        const sendResult = await runMessageAction({
          ...input,
          action: "send",
          params: {
            ...params,
            channel: targetChannel,
            target: resolved.to,
          },
        });
        results.push({
          channel: targetChannel,
          to: resolved.to,
          ...deriveBroadcastEntryOutcome(
            sendResult.kind === "send" ? sendResult.sendResult : undefined,
          ),
          payload: sendResult.kind === "send" ? sendResult.payload : undefined,
          result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        if (err instanceof MessageActionDeniedError) {
          // Preserve the owner fact before broadcast converts the failure to result text;
          // otherwise admitted-run audit would have to infer policy from presentation.
          input.onActionDenied?.(err, targetChannel, receiptDiscriminator);
        }
        results.push({
          channel: targetChannel,
          to: target,
          ok: false,
          error: formatErrorMessage(err),
          ...(err &&
          typeof err === "object" &&
          (err as { sentBeforeError?: unknown }).sentBeforeError === true
            ? { sentBeforeError: true as const }
            : {}),
        });
      }
    }
  }
  return {
    kind: "broadcast",
    channel: targetChannels[0] ?? normalizeOptionalLowercaseString(channelHint) ?? "unknown",
    action: "broadcast",
    handledBy: input.dryRun ? "dry-run" : "core",
    payload: { results },
    dryRun: Boolean(input.dryRun),
  };
}

async function handleInternalSourceReplySendAction(
  input: MessageActionInput,
  params: Record<string, unknown>,
): Promise<MessageActionResult> {
  throwIfAborted(input.abortSignal);
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const sourceReply = await buildMessagePayload({
    cfg: input.cfg,
    actionParams: params,
    input,
    agentId:
      input.agentId ??
      (input.sessionKey
        ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: input.cfg })
        : undefined),
  });
  const payload = {
    status: "ok",
    deliveryStatus: dryRun ? "dry_run" : "sent",
    channel: INTERNAL_MESSAGE_CHANNEL,
    target: "current-run",
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
    ...(dryRun ? {} : { sourceReplySink: "internal-ui" as const }),
    sourceReply: sourceReply.payload,
    ...(sourceReply.message ? { message: sourceReply.message } : {}),
    ...(sourceReply.mediaUrl ? { mediaUrl: sourceReply.mediaUrl } : {}),
    ...(sourceReply.mediaUrls?.length ? { mediaUrls: sourceReply.mediaUrls } : {}),
    dryRun,
  };
  return withSendNormalization(
    {
      kind: "send",
      channel: INTERNAL_MESSAGE_CHANNEL,
      action: "send",
      to: "current-run",
      handledBy: "internal-source",
      payload,
      toolResult: buildInternalSourceReplyToolResult(payload),
      dryRun,
    },
    sourceReply.normalization,
  );
}

function buildInternalSourceReplyToolResult(payload: {
  status: string;
  deliveryStatus: string;
  channel: ChannelId;
  target: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
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
      ...(payload.sourceReplySink ? { sourceReplySink: payload.sourceReplySink } : {}),
      sourceReply: payload.sourceReply,
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
      ...(payload.mediaUrls?.length ? { mediaUrls: payload.mediaUrls } : {}),
      dryRun: payload.dryRun,
    },
  };
}

export async function runMessageAction(input: MessageActionInput): Promise<MessageActionResult> {
  const cfg = input.cfg;
  let params = { ...input.params };
  const resolvedAgentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
      : undefined);
  parseJsonMessageParam(params, "presentation");
  parseJsonMessageParam(params, "delivery");
  parseInteractiveParam(params);

  const action = input.action;
  enforceMessageActionAllowlist({
    cfg,
    agentId: resolvedAgentId,
    action,
  });
  if (action === "broadcast") {
    return handleBroadcastAction({ ...input, agentId: resolvedAgentId }, params);
  }
  if (action === "send" && hasPollCreationParams(params)) {
    throw new Error('Poll fields require action "poll"; use action "poll" instead of "send".');
  }
  if (await shouldUseInternalSourceReplySink(input, params)) {
    return handleInternalSourceReplySendAction({ ...input, agentId: resolvedAgentId }, params);
  }

  const route = await prepareMessageRoute({
    input,
    actionParams: params,
    agentId: resolvedAgentId,
  });
  params = route.params;
  const { channel, channelPlugin, accountId, dryRun, defersExternalTargetResolution } = route;

  const normalizationPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, resolvedAgentId),
  });
  const extraActionMediaSourceParamKeys = resolveExtraActionMediaSourceParamKeys({
    cfg,
    action,
    args: params,
    channel,
    accountId,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    agentId: resolvedAgentId,
    requesterSenderId: input.requesterSenderId,
    senderIsOwner: input.senderIsOwner,
  });
  const structuredAttachmentMode = action === "send" ? "all" : "selected";

  await normalizeSandboxMediaParams({
    args: params,
    mediaPolicy: normalizationPolicy,
    extraParamKeys: extraActionMediaSourceParamKeys,
    structuredAttachments: structuredAttachmentMode,
  });

  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg,
    agentId: resolvedAgentId,
    mediaSources: collectActionMediaSourceHints(params, extraActionMediaSourceParamKeys, {
      structuredAttachments: structuredAttachmentMode,
    }),
    sessionKey: input.sessionKey,
    messageProvider: input.sessionKey ? undefined : channel,
    accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
    requesterSenderId: input.requesterSenderId,
    requesterSenderName: input.requesterSenderName,
    requesterSenderUsername: input.requesterSenderUsername,
    requesterSenderE164: input.requesterSenderE164,
  });
  const mediaPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaAccess,
  });
  const gateway = input.gateway;
  const preserveSendBuffer =
    action === "send" &&
    Boolean(gateway) &&
    (channelPlugin?.actions?.resolveExecutionMode?.({
      action: "send",
    }) === "gateway" ||
      channelPlugin?.outbound?.deliveryMode === "gateway");

  const hydrateActionAttachmentParams = () =>
    hydrateAttachmentParamsForAction({
      cfg,
      channel,
      accountId,
      args: params,
      action,
      dryRun,
      preserveSendBuffer,
      mediaPolicy,
      extraParamKeys: extraActionMediaSourceParamKeys,
    });

  if (action !== "send") {
    await hydrateActionAttachmentParams();
  }

  const resolvedTarget = await resolveMessageTarget({
    cfg,
    channel,
    action,
    args: params,
    accountId,
    toolContext: input.toolContext,
    agentId: resolvedAgentId,
    deferExternalTargetResolution: defersExternalTargetResolution,
  });

  if (action === "send") {
    // Target validation must finish before buffer staging, which can perform
    // filesystem reads and mutate the outbound action payload.
    await hydrateActionAttachmentParams();
  }

  // Channel discovery is process-stable; carry its prepared plugin and route
  // into every action so handlers cannot rediscover a different transport.
  const context: ResolvedActionContext = {
    cfg,
    params,
    idempotencyKey: normalizeOptionalString(params.idempotencyKey),
    channel,
    channelPlugin,
    mediaAccess,
    extraActionMediaSourceParamKeys,
    accountId,
    dryRun,
    gateway,
    input,
    agentId: resolvedAgentId,
    resolvedTarget,
    abortSignal: input.abortSignal,
  };
  if (action === "send") {
    return executeMessageSend(context);
  }
  if (action === "poll") {
    return executeMessagePoll(context);
  }
  return executeMessagePlugin(context);
}
