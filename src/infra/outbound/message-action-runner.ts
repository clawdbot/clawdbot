// Stable facade for message-action normalization, routing, and execution.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { readStringArrayParam, readToolStringParam } from "../../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId, ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { hasPollCreationParams } from "../../poll-params.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import { shouldUseInternalSourceReplySink } from "./internal-source-reply.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";
import {
  resolveMessageSendOutcome,
  type MessageActionInput,
  type MessageActionNormalization,
  type MessageActionResult,
  type ResolvedActionContext,
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
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";

const loadInternalSourceReplyPersistence = createLazyRuntimeModule(
  () => import("../../gateway/internal-source-reply-persistence.js"),
);

export function getToolResult(result: MessageActionResult): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function withSendNormalization(
  result: MessageActionResult,
  normalization?: MessageActionNormalization,
): MessageActionResult {
  return normalization && result.kind === "send" ? { ...result, normalization } : result;
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
  const targetChannels: Array<{ channel: ChannelId; plugin?: ChannelPlugin }> =
    channelHint && normalizeOptionalLowercaseString(channelHint) !== "all"
      ? [
          await resolveMessageChannelSelection({
            cfg: input.cfg,
            channel: channelHint,
            fallbackChannel: input.toolContext?.currentChannelProvider,
            agentId: input.agentId,
          }),
        ]
      : input.broadcastAccountPlan
        ? input.broadcastAccountPlan.candidateChannels.map((channel) => ({
            channel,
            plugin: getRuntimeVisibleChannelPlugin(channel),
          }))
        : await (async () => {
            const configured = await listConfiguredMessageChannels(input.cfg);
            if (configured.length === 0) {
              throw new Error("Broadcast requires at least one configured channel.");
            }
            return configured.map((channel) => ({
              channel,
              plugin: getRuntimeVisibleChannelPlugin(channel),
            }));
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
  for (const { channel: targetChannel, plugin: targetChannelPlugin } of targetChannels) {
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
          plugin: targetChannelPlugin,
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
          ...resolveMessageSendOutcome(
            sendResult.kind === "send" ? sendResult.sendResult : undefined,
            "Broadcast",
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
    channel:
      targetChannels[0]?.channel ?? normalizeOptionalLowercaseString(channelHint) ?? "unknown",
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
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  let persistedIdempotencyKey: string | undefined;
  let persistedTranscriptOwner = false;
  if (!dryRun && input.sessionId) {
    const sessionKey = input.sourceReplySessionKey ?? input.sessionKey;
    if (!sessionKey) {
      throw new Error("Internal source reply requires a session key");
    }
    const { persistInternalSourceReply } = await loadInternalSourceReplyPersistence();
    await persistInternalSourceReply({
      cfg: input.cfg,
      sessionKey,
      expectedSessionId: input.sessionId,
      agentId: input.agentId ?? resolveSessionAgentId({ sessionKey, config: input.cfg }),
      payload: sourceReplyPayload,
      idempotencyKey,
      runId: input.runId,
      sourceReplyFinal: input.sourceReplyFinal,
      toolCallId: input.sourceReplyToolCallId,
      sourceTurnId: input.messageActionAuthorization?.toolContext?.currentSourceTurnId,
    });
    persistedIdempotencyKey = idempotencyKey;
    persistedTranscriptOwner = true;
  }
  const payload = {
    status: "ok",
    deliveryStatus: dryRun ? "dry_run" : "sent",
    channel: INTERNAL_MESSAGE_CHANNEL,
    target: "current-run",
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
    ...(persistedIdempotencyKey ? { idempotencyKey: persistedIdempotencyKey } : {}),
    ...(persistedTranscriptOwner ? { sourceReplyTranscriptOwner: true as const } : {}),
    ...(dryRun ? {} : { sourceReplySink: "internal-ui" as const }),
    sourceReply: sourceReplyPayload,
    ...(sourceReplyMessage ? { message: sourceReplyMessage } : {}),
    ...(sourceReplyMediaUrls[0] ? { mediaUrl: sourceReplyMediaUrls[0] } : {}),
    ...(sourceReplyMediaUrls.length ? { mediaUrls: sourceReplyMediaUrls } : {}),
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

  const resolveMediaAccess = () =>
    input.mediaAccess ??
    resolveAgentScopedOutboundMediaAccess({
      cfg,
      agentId: resolvedAgentId,
      mediaSources: collectActionMediaSourceHints(params, extraActionMediaSourceParamKeys, {
        structuredAttachments: structuredAttachmentMode,
      }),
      workspaceMediaAccess: input.workspaceMediaAccess,
      sessionKey: input.sessionKey,
      messageProvider: input.sessionKey ? undefined : channel,
      accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
      requesterSenderId: input.requesterSenderId,
      requesterSenderName: input.requesterSenderName,
      requesterSenderUsername: input.requesterSenderUsername,
      requesterSenderE164: input.requesterSenderE164,
    });
  const mediaAccess = resolveMediaAccess();
  const sandboxMediaReadFile = input.workspaceMediaAccess?.readFile
    ? mediaAccess.readFile
    : undefined;
  const normalizationPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    sandboxContainerWorkdir: input.sandboxContainerWorkdir,
    mediaAccess,
    mediaReadFile: sandboxMediaReadFile,
  });

  await normalizeSandboxMediaParams({
    args: params,
    mediaPolicy: normalizationPolicy,
    extraParamKeys: extraActionMediaSourceParamKeys,
    structuredAttachments: structuredAttachmentMode,
  });
  const mediaPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    sandboxContainerWorkdir: input.sandboxContainerWorkdir,
    mediaAccess,
    mediaReadFile: sandboxMediaReadFile,
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
    plugin: channelPlugin,
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
