import { asOptionalRecord as asResultRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import {
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "../../agents/tools/common.js";
import type { OutboundReplyFacts } from "../../channels/message/types.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeMessagePresentation } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import type {
  MessageActionGateway,
  MessageActionInput,
  MessageActionResult,
  ResolvedActionContext,
} from "./message-action-contracts.js";
import { resolveAndApplyOutboundThreadId } from "./message-action-threading.js";
import { resolveOutboundMessageGatewayOptions } from "./message-gateway-options.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { executePollAction } from "./outbound-send-service.js";
import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  isCurrentSourceReplyActionName,
  isDeliveredCurrentSourceReply,
  isDeliveredCurrentSourceReplyAction,
  isThreadPlacementSourceReplyActionName,
  reconcileTerminalSourceReplyDelivery,
} from "./source-reply-mirror.js";

const log = createSubsystemLogger("outbound/message-action");

// Gateway runtime is only needed for remote message action dispatch or
// idempotency keys; keep normal in-process actions import-light.
const loadMessageActionGatewayRuntime = createLazyRuntimeModule(
  () => import("./message.gateway.runtime.js"),
);

export function annotateSourceDelivery<T extends MessageActionResult>(
  result: T,
  params: {
    cfg: OpenClawConfig;
    actionParams: Record<string, unknown>;
    channel: ChannelId;
    accountId?: string | null;
    input: MessageActionInput;
    agentId?: string;
    replyToIsExplicit: boolean;
  },
): T {
  // Current-source identity comes from the authorized route and delivery receipt,
  // not the reply mode; automatic runs also use this marker to avoid false fallbacks.
  // Reply-type actions, thread replies, and polls are visible source replies too:
  // leaving them unmarked makes dispatch send the no-visible-reply fallback after
  // the channel has already delivered a visible result.
  const isMessageIdReplyActionResult =
    result.kind === "action" && isCurrentSourceReplyActionName(result.action);
  const isThreadPlacementReplyActionResult =
    result.kind === "action" && isThreadPlacementSourceReplyActionName(result.action);
  if (
    result.kind !== "send" &&
    result.kind !== "poll" &&
    !isMessageIdReplyActionResult &&
    !isThreadPlacementReplyActionResult
  ) {
    return result;
  }
  const authorization = params.input.messageActionAuthorization;
  if (!authorization?.toolContext) {
    return result;
  }
  const mirrorParams = {
    action:
      isMessageIdReplyActionResult || isThreadPlacementReplyActionResult
        ? result.action
        : result.kind === "poll"
          ? "poll"
          : "send",
    channel: params.channel,
    actionParams: params.actionParams,
    cfg: params.cfg,
    accountId: params.accountId,
    currentAccountId: authorization.requesterAccountId ?? params.input.defaultAccountId,
    sessionKey: params.input.sessionKey,
    sessionId: params.input.sessionId,
    agentId: params.agentId,
    toolContext: authorization.toolContext,
    deliveredPayload: result.payload,
    replyToIsExplicit: params.replyToIsExplicit,
  };
  if (
    isMessageIdReplyActionResult
      ? !isDeliveredCurrentSourceReplyAction(mirrorParams)
      : !isDeliveredCurrentSourceReply(mirrorParams)
  ) {
    return result;
  }
  const payload = asResultRecord(result.payload);
  const details = asResultRecord(result.toolResult?.details);
  return {
    ...result,
    payload: payload ? { ...payload, sourceReplyRoute: "current-source" } : result.payload,
    ...(result.toolResult
      ? {
          toolResult: {
            ...result.toolResult,
            details: { ...details, sourceReplyRoute: "current-source" },
          },
        }
      : {}),
  } as T;
}

const MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS = 60_000;
const MESSAGE_ACTION_RECONCILIATION_MAX_MS = 9 * 60_000;
const MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS = 30_000;

async function callGatewayMessageAction<T>(params: {
  gateway?: MessageActionGateway;
  actionParams: Record<string, unknown>;
  agentRuntimeIdentityToken?: string;
  abortSignal?: AbortSignal;
  onUnknownDeliveryOutcome?: () => void;
}): Promise<T> {
  const { callGatewayLeastPrivilege, isGatewayTransportError } =
    await loadMessageActionGatewayRuntime();
  const gateway = resolveOutboundMessageGatewayOptions(params.gateway);
  // A timed-out send is reattached with the same idempotency key. Cap only the
  // initial wait so the 9-minute join remains inside Codex's 10-minute tool envelope.
  const timeoutMs =
    params.actionParams.action === "send"
      ? Math.min(gateway.timeoutMs, MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS)
      : gateway.timeoutMs;
  const call = {
    url: gateway.url,
    token: gateway.token,
    method: "message.action",
    params: params.actionParams,
    timeoutMs,
    signal: params.abortSignal,
    clientName: gateway.clientName,
    clientDisplayName: gateway.clientDisplayName,
    mode: gateway.mode,
    agentRuntimeIdentityToken: params.agentRuntimeIdentityToken,
  };
  try {
    return await callGatewayLeastPrivilege<T>(call);
  } catch (error) {
    if (
      !isGatewayTransportError(error) ||
      error.kind !== "timeout" ||
      params.actionParams.action !== "send"
    ) {
      throw error;
    }
    // The Gateway may still finish the first request after the local timer.
    // Nothing learned by a later reattach can prove that attempt did not send.
    params.onUnknownDeliveryOutcome?.();
    throwIfAborted(params.abortSignal);
  }

  const reconciliationSignal = params.abortSignal
    ? AbortSignal.any([
        params.abortSignal,
        AbortSignal.timeout(MESSAGE_ACTION_RECONCILIATION_MAX_MS),
      ])
    : undefined;
  const reconciliationCall = {
    ...call,
    // `null` keeps startup bounded but removes the per-request timer after
    // hello. The dedicated signal bounds a joined in-flight action without
    // reconnecting every minute or inheriting the run's much longer lifetime.
    timeoutMs: params.abortSignal
      ? null
      : Math.max(call.timeoutMs, MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS),
    signal: reconciliationSignal,
  };
  // A caller-side timeout does not cancel Gateway work. Reattach once with the
  // unchanged idempotency key so the live Gateway can join the original work.
  return await callGatewayLeastPrivilege<T>(reconciliationCall);
}

function isConfirmedGatewayMessageActionRejection(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { details?: unknown; gatewayCode?: unknown };
  if (typeof requestError.gatewayCode !== "string" || requestError.gatewayCode.length === 0) {
    return false;
  }
  if (requestError.gatewayCode !== ErrorCodes.UNAVAILABLE) {
    // Authorization, scope, validation, and unknown-method errors are emitted
    // before message.action enters its provider dispatch path.
    return true;
  }
  const details = requestError.details;
  // Gateway startup/suspension rejection carries the method name. Provider
  // exceptions use an unstructured UNAVAILABLE response and remain ambiguous.
  return (
    details !== null &&
    typeof details === "object" &&
    (details as { method?: unknown }).method === "message.action"
  );
}

export function projectGatewayQueuedDeliveryResult(error: unknown) {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = asResultRecord(asResultRecord(error)?.details);
  if (details?.code !== GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED) {
    return undefined;
  }
  return {
    status: "delivery_queued",
    delivered: false as const,
    message: `Message not delivered: ${error.message}. The gateway queued it and will retry automatically. Do not resend it.`,
  };
}

async function resolveGatewayActionIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageActionGatewayRuntime();
  return randomIdempotencyKey();
}

function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferPresentation,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferPresentation: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferPresentation,
  });
  params.message = applied.message;
  if (applied.presentation) {
    const existing = normalizeMessagePresentation(params.presentation);
    params.presentation = existing
      ? {
          ...existing,
          blocks: [...applied.presentation.blocks, ...existing.blocks],
        }
      : applied.presentation;
  }
  return applied.message;
}

export async function applyMessageCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  agentId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferPresentation: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
    agentId: params.agentId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferPresentation: params.preferPresentation,
  });
}

export async function executeGatewayAction(params: {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  channelPlugin?: ChannelPlugin;
  action: ChannelMessageActionName;
  reply?: OutboundReplyFacts;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionGateway;
  input: MessageActionInput;
  agentId?: string;
  result: (payload: unknown) => MessageActionResult;
}): Promise<MessageActionResult | null> {
  if (params.dryRun || !params.gateway) {
    return null;
  }
  if (!params.channelPlugin?.actions?.handleAction) {
    return null;
  }
  const executionMode =
    params.channelPlugin.actions.resolveExecutionMode?.({ action: params.action }) ?? "local";
  if (executionMode !== "gateway") {
    return null;
  }
  const conversationReadOrigin = normalizeConversationReadInvocationOrigin(
    params.input.conversationReadOrigin,
  );
  const idempotencyKey = await resolveGatewayActionIdempotencyKey(
    normalizeOptionalString(params.params.idempotencyKey),
  );
  const callerOwnsTerminalReceipt =
    params.gateway.terminalSourceReplyReceiptOwner === "caller" &&
    params.input.sourceReplyFinal === true;
  // Resolve local capability/auth preflight before arming a durable send intent.
  // A failure here proves the RPC never reached the gateway.
  const agentRuntimeIdentityToken = await params.gateway.resolveAgentRuntimeIdentityToken?.({
    sourceReplyFinal: params.input.sourceReplyFinal,
    sourceReplyToolCallId: params.input.sourceReplyToolCallId,
  });
  const sourceReplyMirror = {
    action: params.action,
    channel: params.channel,
    actionParams: params.params,
    cfg: params.cfg,
    accountId: params.accountId,
    currentAccountId:
      params.input.messageActionAuthorization?.requesterAccountId ?? params.input.defaultAccountId,
    sessionKey: params.input.sourceReplySessionKey ?? params.input.sessionKey,
    sessionId: params.input.sessionId,
    agentId: params.agentId,
    toolContext: params.input.messageActionAuthorization?.toolContext,
    replyToIsExplicit: params.reply?.source === "explicit",
    idempotencyKey,
    sourceReplyFinal: params.input.sourceReplyFinal,
    toolCallId: params.input.sourceReplyToolCallId,
  };
  const terminalDeliveryStart = callerOwnsTerminalReceipt
    ? await beginTerminalSourceReplyDelivery(sourceReplyMirror)
    : undefined;
  if (terminalDeliveryStart && "outcome" in terminalDeliveryStart) {
    return params.result(terminalDeliveryStart.result);
  }
  const terminalDeliveryReceipt = terminalDeliveryStart;
  let hadUnknownDeliveryOutcome = false;
  let payload: unknown;
  try {
    payload = await callGatewayMessageAction<unknown>({
      gateway: params.gateway,
      abortSignal: params.input.abortSignal,
      agentRuntimeIdentityToken,
      onUnknownDeliveryOutcome: () => {
        hadUnknownDeliveryOutcome = true;
      },
      actionParams: {
        channel: params.channel,
        action: params.action,
        params: params.params,
        ...(params.reply ? { reply: params.reply } : {}),
        accountId: params.accountId ?? undefined,
        senderIsOwner: params.input.senderIsOwner,
        sessionKey: params.input.sessionKey,
        sessionId: params.input.sessionId,
        inboundTurnKind: params.input.inboundEventKind,
        agentId: params.agentId,
        ...(conversationReadOrigin === "direct-operator" ? { conversationReadOrigin } : {}),
        idempotencyKey,
      },
    });
  } catch (error) {
    if (
      callerOwnsTerminalReceipt &&
      !hadUnknownDeliveryOutcome &&
      isConfirmedGatewayMessageActionRejection(error)
    ) {
      await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
    }
    throw error;
  }
  if (callerOwnsTerminalReceipt) {
    try {
      await reconcileTerminalSourceReplyDelivery({
        deliveredPayload: payload,
        mirror: sourceReplyMirror,
        receipt: terminalDeliveryReceipt,
        ...(hadUnknownDeliveryOutcome ? { preservePendingOnExplicitFailure: true } : {}),
      });
    } catch (error) {
      // The pre-send intent remains durable. Return the provider result so the
      // model cannot retry an external effect with an unknown outcome.
      log.warn("Terminal source reply receipt reconciliation failed.", {
        channel: params.channel,
        sessionKey: params.input.sessionKey,
        error: formatErrorMessage(error),
      });
    }
  }
  return params.result(payload);
}

export async function executeMessagePoll(ctx: ResolvedActionContext): Promise<MessageActionResult> {
  const {
    cfg,
    params,
    channel,
    channelPlugin,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readToolStringParam(params, "to", { required: true });
  const silent = readBooleanParam(params, "silent");

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    to,
    accountId,
    toolContext: input.toolContext,
    resolveAutoThreadId: channelPlugin?.threading?.resolveAutoThreadId,
  });

  const base = typeof params.message === "string" ? params.message : "";
  await applyMessageCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    agentId,
    args: params,
    message: base,
    preferPresentation: false,
  });

  const gatewayPluginAction = await executeGatewayAction({
    cfg,
    params,
    channel,
    channelPlugin,
    action,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    result: (payload) => ({
      kind: "poll",
      channel,
      action,
      to,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  const pollReplyToIsExplicit = Boolean(readToolStringParam(params, "replyTo"));
  if (gatewayPluginAction) {
    return annotateSourceDelivery(gatewayPluginAction, {
      cfg,
      actionParams: params,
      channel,
      accountId,
      input,
      agentId,
      replyToIsExplicit: pollReplyToIsExplicit,
    });
  }

  const poll = await executePollAction({
    ctx: {
      cfg,
      channel,
      plugin: channelPlugin,
      params,
      idempotencyKey: ctx.idempotencyKey,
      accountId: accountId ?? undefined,
      agentId,
      requesterAccountId: input.requesterAccountId ?? undefined,
      requesterSenderId: input.requesterSenderId ?? undefined,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      inboundEventKind: input.inboundEventKind,
      gateway,
      toolContext: input.toolContext,
      dryRun,
      silent: silent ?? undefined,
    },
    resolveCorePoll: () => {
      const question = readToolStringParam(params, "pollQuestion", {
        required: true,
      });
      const options = readStringArrayParam(params, "pollOption", { required: true });
      if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
      }
      const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
      const durationHours = readPositiveIntegerParam(params, "pollDurationHours", {
        message: "pollDurationHours must be a positive integer",
      });

      return {
        to,
        question,
        content: readToolStringParam(params, "message", { allowEmpty: true }) ?? undefined,
        options,
        maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
      };
    },
  });

  return annotateSourceDelivery(
    {
      kind: "poll",
      channel,
      action,
      to,
      handledBy: poll.handledBy,
      payload: poll.payload,
      toolResult: poll.toolResult,
      pollResult: poll.pollResult,
      dryRun,
    },
    {
      cfg,
      actionParams: params,
      channel,
      accountId,
      input,
      agentId,
      replyToIsExplicit: pollReplyToIsExplicit,
    },
  );
}

export async function executeMessagePlugin(
  ctx: ResolvedActionContext,
): Promise<MessageActionResult> {
  const {
    cfg,
    params,
    channel,
    channelPlugin,
    mediaAccess,
    accountId,
    dryRun,
    gateway,
    input,
    abortSignal,
    agentId,
  } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  if (!channelPlugin?.actions?.handleAction) {
    throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
  }

  // Plugin actions bypass buildSendPayloadParts, so model-authored text here
  // never crossed the outbound text hygiene sends get: reply/edit deliveries
  // leaked raw citation control markers to end users.
  const rawActionMessage = params.message;
  if (typeof rawActionMessage === "string" && rawActionMessage) {
    params.message = stripPlainTextToolCallBlocks(
      stripUnsupportedCitationControlMarkers(rawActionMessage),
    );
  }

  // Plugin actions bypass send/poll, so inherit thread metadata before either
  // gateway or local dispatch to keep both execution modes on the same topic.
  const targetForThreading =
    normalizeOptionalString(params.to) ?? normalizeOptionalString(params.channelId) ?? "";
  // Downloads and channel canvases use explicit resource scope. Ambient threading
  // must not narrow that scope or turn a channel-canvas action into a thread action.
  const inheritsThreadScope =
    action !== "download-file" && action !== "canvas-create" && action !== "canvas-edit";
  if (targetForThreading && inheritsThreadScope) {
    resolveAndApplyOutboundThreadId(params, {
      cfg,
      to: targetForThreading,
      accountId,
      toolContext: input.toolContext,
      resolveAutoThreadId: channelPlugin.threading?.resolveAutoThreadId,
      resolveReplyTransport: channelPlugin.threading?.resolveReplyTransport,
      replyToIsExplicit: Boolean(readToolStringParam(params, "replyTo")),
    });
  }

  const gatewayPluginAction = await executeGatewayAction({
    cfg,
    params,
    channel,
    channelPlugin,
    action,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    result: (payload) => ({
      kind: "action",
      channel,
      action,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  const replyToIsExplicit = Boolean(readToolStringParam(params, "replyTo"));
  if (gatewayPluginAction) {
    // Gateway-owned actions must execute where the live channel runtime exists.
    return annotateSourceDelivery(gatewayPluginAction, {
      cfg,
      actionParams: params,
      channel,
      accountId,
      input,
      agentId,
      replyToIsExplicit,
    });
  }

  const authorization = input.messageActionAuthorization;
  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    mediaAccess,
    mediaLocalRoots: mediaAccess.localRoots,
    mediaReadFile: mediaAccess.readFile,
    accountId: accountId ?? undefined,
    requesterAccountId:
      authorization !== undefined
        ? authorization.requesterAccountId
        : (input.requesterAccountId ?? undefined),
    requesterSenderId:
      authorization !== undefined
        ? authorization.requesterSenderId
        : (input.requesterSenderId ?? undefined),
    senderIsOwner: input.senderIsOwner,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(input.conversationReadOrigin),
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    inboundEventKind: input.inboundEventKind,
    agentId,
    gateway,
    toolContext: authorization !== undefined ? authorization.toolContext : input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return annotateSourceDelivery(
    {
      kind: "action",
      channel,
      action,
      handledBy: "plugin",
      payload: extractToolPayload(handled),
      toolResult: handled,
      dryRun,
    },
    {
      cfg,
      actionParams: params,
      channel,
      accountId,
      input,
      agentId,
      replyToIsExplicit,
    },
  );
}
