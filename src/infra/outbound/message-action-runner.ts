// Stable facade for message-action normalization, routing, and execution.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { readStringArrayParam, readToolStringParam } from "../../agents/tools/common.js";
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
import { executeMessageSend } from "./message-action-send.js";
import {
  buildInternalSourceReplyToolResult,
  prepareInternalSourceReplyPayload,
  resolvesToCurrentSourceRoute,
} from "./message-action-source-reply.js";
import type { MessageSendResult } from "./message.js";
import {
  enforceMessageActionAllowlist,
  resolveEffectiveMessageToolsConfig,
} from "./outbound-policy.js";
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";

export { prepareInternalSourceReplyPayload };

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
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    sentBeforeError?: true;
    payload?: unknown;
    result?: MessageSendResult;
  }> = [];
  type BroadcastPlanEntry =
    | {
        kind: "send";
        channel: ChannelId;
        inputTarget: string;
        resolvedTo: string;
        accountId?: string | null;
        actionParams: Record<string, unknown>;
        receiptDiscriminator: string;
      }
    | {
        kind: "error";
        channel: ChannelId;
        inputTarget: string;
        error: unknown;
        receiptDiscriminator: string;
      };
  const plan: BroadcastPlanEntry[] = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  let attemptIndex = 0;

  // Preserve the established sequential broadcast behavior unless this exact
  // run carries the private source-finalization fence. Only fenced turns need
  // all-leg preflight to prevent a foreign leg from sending before a later
  // current-source leg is rejected.
  if (input.deferSourceMessageToolDelivery !== true || dryRun) {
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

  // Resolve every leg before any provider call. Broadcast is non-atomic, so
  // this preflight is what guarantees a mixed broadcast cannot send its
  // foreign legs before discovering that another leg is the freshness-fenced
  // current source route.
  for (const { channel: targetChannel } of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      const receiptDiscriminator = `broadcast:${attemptIndex++}`;
      try {
        const legParams: Record<string, unknown> = {
          ...params,
          channel: targetChannel,
          target,
          ...(explicitAccountId ? { accountId: explicitAccountId } : {}),
        };
        const legInput: MessageActionInput = {
          ...input,
          action: "send",
          params: legParams,
        };
        const route = await prepareMessageRoute({
          input: legInput,
          actionParams: legParams,
          agentId: input.agentId,
        });
        const resolved = await resolveMessageTarget({
          cfg: input.cfg,
          channel: route.channel,
          action: "send",
          args: route.params,
          accountId: route.accountId,
          toolContext: input.toolContext,
          agentId: input.agentId,
          plugin: route.channelPlugin,
        });
        if (!resolved) {
          throw new Error("Broadcast target resolution unexpectedly deferred.");
        }
        plan.push({
          kind: "send",
          channel: route.channel,
          inputTarget: target,
          resolvedTo: resolved.to,
          accountId: route.accountId,
          actionParams: route.params,
          receiptDiscriminator,
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
        plan.push({
          kind: "error",
          channel: targetChannel,
          inputTarget: target,
          error: err,
          receiptDiscriminator,
        });
      }
    }
  }

  if (
    plan.some(
      (entry) =>
        entry.kind === "send" &&
        resolvesToCurrentSourceRoute({
          input,
          actionParams: {
            ...entry.actionParams,
            to: entry.resolvedTo,
          },
          channel: entry.channel,
          accountId: entry.accountId,
          dryRun,
        }),
    )
  ) {
    throw new MessageActionDeniedError(
      "Broadcast cannot include the current source route while its final reply is awaiting host-owned finalization.",
      "message_broadcast_host_final_unsupported",
      "message-source-final:broadcast",
    );
  }

  for (const entry of plan) {
    throwIfAborted(input.abortSignal);
    if (entry.kind === "error") {
      results.push({
        channel: entry.channel,
        to: entry.inputTarget,
        ok: false,
        error: formatErrorMessage(entry.error),
        ...(entry.error &&
        typeof entry.error === "object" &&
        // SAFETY: The preceding short-circuit guard narrows this error to a non-null object before the optional field read.
        (entry.error as { sentBeforeError?: unknown }).sentBeforeError === true
          ? { sentBeforeError: true as const }
          : {}),
      });
      continue;
    }
    try {
      const sendResult = await runMessageAction({
        ...input,
        action: "send",
        params: {
          ...entry.actionParams,
          to: entry.resolvedTo,
        },
      });
      results.push({
        channel: entry.channel,
        to: entry.resolvedTo,
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
        input.onActionDenied?.(err, entry.channel, entry.receiptDiscriminator);
      }
      results.push({
        channel: entry.channel,
        to: entry.resolvedTo,
        ok: false,
        error: formatErrorMessage(err),
        ...(err &&
        typeof err === "object" &&
        // SAFETY: The preceding short-circuit guard narrows this error to a non-null object before the optional field read.
        (err as { sentBeforeError?: unknown }).sentBeforeError === true
          ? { sentBeforeError: true as const }
          : {}),
      });
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
  const prepared = await prepareInternalSourceReplyPayload(input, params);
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
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
      payload: prepared.payload,
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
    sourceReply: prepared.payload,
    ...(prepared.message ? { message: prepared.message } : {}),
    ...(prepared.mediaUrls[0] ? { mediaUrl: prepared.mediaUrls[0] } : {}),
    ...(prepared.mediaUrls.length ? { mediaUrls: prepared.mediaUrls } : {}),
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
    prepared.normalization,
  );
}

async function handleDeferredHostFinalAction(params: {
  input: MessageActionInput;
  actionParams: Record<string, unknown>;
  channel: ChannelId;
  accountId?: string | null;
  agentId?: string;
}): Promise<MessageActionResult> {
  if (params.input.deferredSourceReplyFinalIntent === false) {
    const details = {
      status: "suppressed",
      deliveryStatus: "suppressed",
      reason: "source_progress_host_final_unsupported",
      sourceReplySink: "host-final" as const,
    };
    const target =
      readToolStringParam(params.actionParams, "to") ??
      readToolStringParam(params.actionParams, "target") ??
      readToolStringParam(params.actionParams, "channelId") ??
      "current-source";
    return {
      kind: "send",
      channel: params.channel,
      action: "send",
      to: target,
      handledBy: "host-final",
      payload: details,
      toolResult: {
        content: [
          {
            type: "text",
            text: "Skipped the non-final current-source progress send. Continue the run and provide the completed answer normally.",
          },
        ],
        details,
      },
      dryRun: false,
    };
  }
  const prepared = await prepareInternalSourceReplyPayload(
    { ...params.input, action: "send", agentId: params.agentId },
    params.actionParams,
    { channel: params.channel, accountId: params.accountId },
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
  const target =
    readToolStringParam(params.actionParams, "to") ??
    readToolStringParam(params.actionParams, "target") ??
    readToolStringParam(params.actionParams, "channelId") ??
    "current-source";
  return withSendNormalization(
    {
      kind: "send",
      channel: params.channel,
      action: "send",
      to: target,
      handledBy: "host-final",
      payload: details,
      toolResult: {
        content: [
          {
            type: "text",
            text: "Prepared the current-source reply for automatic host delivery. Do not retry it with the message tool.",
          },
        ],
        details,
      },
      dryRun: false,
    },
    prepared.normalization,
  );
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

  const delayNonSendHydrationForSourceFence =
    action !== "send" && input.deferSourceMessageToolDelivery === true && !dryRun;
  if (action !== "send" && !delayNonSendHydrationForSourceFence) {
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

  const currentSourceRoute = resolvesToCurrentSourceRoute({
    input,
    actionParams: params,
    channel,
    accountId,
    dryRun,
  });
  if (currentSourceRoute) {
    if (action === "send" || action === "reply") {
      return await handleDeferredHostFinalAction({
        input,
        actionParams: params,
        channel,
        accountId,
        agentId: resolvedAgentId,
      });
    }
    if (action === "poll") {
      throw new MessageActionDeniedError(
        "A poll cannot be published to the current source while its final reply is awaiting host-owned finalization.",
        "message_poll_host_final_unsupported",
        "message-source-final:poll",
      );
    }
  }

  if (delayNonSendHydrationForSourceFence) {
    await hydrateActionAttachmentParams();
  }

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
