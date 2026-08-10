// Source reply mirroring records successful same-conversation message-tool
// sends back into the owning session transcript.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveChannelThreadAddressing } from "../../channels/thread-addressing.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  type RestartRecoveryTerminalDeliveryScope,
} from "../../config/sessions/restart-recovery-receipt.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForMirror } from "./payloads.js";

type SourceReplyTranscriptMirrorParams = {
  action: string;
  channel: string;
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  currentAccountId?: string | null;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  toolContext?: InternalChannelThreadingToolContext;
  idempotencyKey?: string;
  sourceReplyFinal?: boolean;
  toolCallId?: string;
  deliveredPayload?: unknown;
  replyToIsExplicit?: boolean;
};

type TerminalSourceReplyDeliveryStart =
  | TerminalSourceReplyDeliveryReceipt
  | {
      outcome: "already_delivered" | "delivery_ambiguous";
      result: { status: string; delivered: false; message: string };
    }
  | undefined;

function buildTerminalSourceReplyNoSendResult(outcome: "already_delivered" | "delivery_ambiguous") {
  return {
    outcome,
    result: {
      status: outcome,
      delivered: false as const,
      message:
        outcome === "already_delivered"
          ? "The completed reply was already delivered. Do not retry it."
          : "The completed reply may already have been delivered. Do not retry it.",
    },
  };
}

type MirrorableSourceReplyTranscriptParams = SourceReplyTranscriptMirrorParams & {
  sessionKey: string;
};

type TerminalSourceReplyDeliveryReceipt = RestartRecoveryTerminalDeliveryScope;

type SourceReplyThreadPlacement = "match" | "mismatch" | "unknown";

// Mirror only enough delivered payload detail to preserve transcript context.
function readStringArray(value: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(value);
}

function readFirstString(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return readTrimmedStringAlias(params, keys);
}

function resolveSourceReplyTarget(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["target", "to", "channelId", "chatId"]);
}

function resolveSourceReplyThreadId(params: SourceReplyTranscriptMirrorParams): string | undefined {
  return readFirstString(params.actionParams, ["threadId", "messageThreadId"]);
}

function resolveDeliveredThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
  currentThreadId: string | undefined,
): SourceReplyThreadPlacement | undefined {
  const payload = asRecord(params.deliveredPayload);
  const result = asRecord(payload?.result);
  const receipt = asRecord(result?.receipt) ?? asRecord(payload?.receipt);
  if (!receipt) {
    return undefined;
  }
  const deliveredThreadId = normalizeOptionalString(receipt.threadId);
  return deliveredThreadId
    ? deliveredThreadId === currentThreadId
      ? "match"
      : "mismatch"
    : currentThreadId
      ? "mismatch"
      : "match";
}

function resolveSourceReplyThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
  threadAddressing: ReturnType<typeof resolveChannelThreadAddressing>,
): SourceReplyThreadPlacement {
  const currentThreadId = normalizeOptionalString(params.toolContext?.currentThreadTs);
  const deliveredPlacement = resolveDeliveredThreadPlacement(params, currentThreadId);
  if (deliveredPlacement) {
    return deliveredPlacement;
  }
  if (params.actionParams.topLevel === true) {
    return currentThreadId ? "mismatch" : "match";
  }
  if (
    threadAddressing === "message" &&
    params.replyToIsExplicit === true &&
    !currentThreadId &&
    normalizeOptionalString(params.actionParams.replyTo)
  ) {
    return "mismatch";
  }
  for (const key of ["threadId", "messageThreadId"] as const) {
    if (!Object.hasOwn(params.actionParams, key)) {
      continue;
    }
    const explicitThreadId = normalizeOptionalString(params.actionParams[key]);
    if (!explicitThreadId) {
      return currentThreadId ? "mismatch" : "match";
    }
    return explicitThreadId === currentThreadId ? "match" : "mismatch";
  }
  return currentThreadId ? "unknown" : "match";
}

function resolveThreadedSourceTarget(
  params: SourceReplyTranscriptMirrorParams,
  requestedTarget: string,
): string {
  const threadId = resolveSourceReplyThreadId(params);
  if (!threadId) {
    return requestedTarget;
  }
  return (
    normalizeOptionalString(
      getChannelPlugin(params.channel as ChannelId)?.threading?.resolveCurrentChannelId?.({
        to: requestedTarget,
        threadId,
      }),
    ) ?? requestedTarget
  );
}

function hasExplicitDeliveryFailure(payload: unknown, depth = 0): boolean {
  if (!payload || typeof payload !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((value) => hasExplicitDeliveryFailure(value, depth + 1));
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false || record.delivered === false || record.dryRun === true) {
    return true;
  }
  const messageId = normalizeOptionalLowercaseString(record.messageId);
  if (messageId === "skipped" || messageId === "suppressed") {
    return true;
  }
  const status = normalizeOptionalLowercaseString(record.status);
  if (
    status === "failed" ||
    status === "error" ||
    status === "skipped" ||
    status === "suppressed" ||
    status === "dry_run"
  ) {
    return true;
  }
  const deliveryStatus = normalizeOptionalLowercaseString(record.deliveryStatus);
  if (
    deliveryStatus === "failed" ||
    deliveryStatus === "error" ||
    deliveryStatus === "skipped" ||
    deliveryStatus === "suppressed" ||
    deliveryStatus === "dry_run"
  ) {
    return true;
  }
  return ["details", "payload", "result", "results", "sendResult", "toolResult"].some((key) =>
    hasExplicitDeliveryFailure(record[key], depth + 1),
  );
}

function resolveCurrentSourceTurnId(
  toolContext: InternalChannelThreadingToolContext | undefined,
): string | undefined {
  return normalizeOptionalString(toolContext?.currentSourceTurnId);
}

function resolveTerminalSourceReplyDeliveryReceipt(
  params: SourceReplyTranscriptMirrorParams,
): TerminalSourceReplyDeliveryReceipt | undefined {
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (params.sourceReplyFinal !== true) {
    return undefined;
  }
  if (!toolCallId) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  if (!params.sessionId || !isCurrentSourceConversation(params)) {
    return undefined;
  }
  const sourceTurnId = resolveCurrentSourceTurnId(params.toolContext);
  if (!sourceTurnId) {
    return undefined;
  }
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  // Agent admission promotes legacy aliases before the run starts. The signed
  // runtime session key therefore owns both the active claim and transcript.
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sourceTurnId,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId }),
    toolCallId,
  };
}

/** Arms the fail-closed state before a terminal source reply can reach a provider. */
export async function beginTerminalSourceReplyDelivery(
  params: SourceReplyTranscriptMirrorParams,
): Promise<TerminalSourceReplyDeliveryStart> {
  const receipt = resolveTerminalSourceReplyDeliveryReceipt(params);
  if (!receipt) {
    return undefined;
  }
  const result = await beginRestartRecoveryTerminalDelivery(receipt);
  if (result === "not-applicable") {
    return undefined;
  }
  if (result === "already-delivered") {
    return buildTerminalSourceReplyNoSendResult("already_delivered");
  }
  if (result === "delivery-ambiguous" || result === "stale") {
    return buildTerminalSourceReplyNoSendResult("delivery_ambiguous");
  }
  return receipt;
}

/** Cancels a pre-send intent only when dispatch proved that no send occurred. */
export async function cancelTerminalSourceReplyDelivery(
  receipt: TerminalSourceReplyDeliveryReceipt | undefined,
): Promise<void> {
  if (receipt) {
    await cancelRestartRecoveryTerminalDelivery(receipt);
  }
}

/** Reconciles the provider result while an unresolved intent remains fail closed. */
export async function reconcileTerminalSourceReplyDelivery(params: {
  deliveredPayload: unknown;
  mirror: SourceReplyTranscriptMirrorParams;
  preservePendingOnExplicitFailure?: boolean;
  receipt: TerminalSourceReplyDeliveryReceipt | undefined;
}): Promise<"delivered" | "not-delivered" | "not-source" | "not-applicable" | "pending"> {
  if (!params.receipt) {
    return "not-applicable";
  }
  if (hasExplicitDeliveryFailure(params.deliveredPayload)) {
    if (params.preservePendingOnExplicitFailure) {
      return "pending";
    }
    await cancelRestartRecoveryTerminalDelivery(params.receipt);
    return "not-delivered";
  }
  if (
    !isExactCurrentSourceConversation({
      ...params.mirror,
      deliveredPayload: params.deliveredPayload,
    })
  ) {
    return "not-source";
  }
  await completeRestartRecoveryTerminalDelivery(params.receipt);
  return "delivered";
}

function resolveTranscriptMirrorIdempotencyKey(params: {
  idempotencyKey?: string;
  sourceReplyFinal?: boolean;
  sourceTurnId?: string;
}): string | undefined {
  if (params.sourceReplyFinal !== true || !params.idempotencyKey || !params.sourceTurnId) {
    return params.idempotencyKey;
  }
  // Progress and terminal mirrors may share provider idempotency. Transcript
  // receipts need distinct keys so a progress row cannot mask the terminal marker.
  return `${params.idempotencyKey}:terminal-receipt:${params.sourceTurnId}`;
}

function isCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
  threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  ),
): params is MirrorableSourceReplyTranscriptParams {
  // Polls share the send target contract: `to` addresses a conversation, so the
  // same current-source matching applies. Transcript mirroring stays send-only
  // because poll params carry no message text to mirror.
  if (params.action !== "send" && params.action !== "poll") {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return false;
  }
  const toolContext = params.toolContext;
  if (!toolContext) {
    return false;
  }
  const accountId = normalizeOptionalString(params.accountId);
  if (accountId) {
    const currentAccountId = normalizeOptionalString(params.currentAccountId);
    if (
      !currentAccountId ||
      normalizeAccountId(accountId) !== normalizeAccountId(currentAccountId)
    ) {
      return false;
    }
  }
  const currentChannel = normalizeOptionalLowercaseString(toolContext.currentChannelProvider);
  if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) {
    return false;
  }
  const currentTargets = [
    normalizeOptionalString(toolContext.currentMessagingTarget),
    normalizeOptionalString(toolContext.currentChannelId),
  ].filter((target): target is string => Boolean(target));
  if (currentTargets.length === 0) {
    return false;
  }
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (!requestedTarget) {
    return false;
  }
  if (threadPlacement === "mismatch") {
    return false;
  }
  const threadedTarget = resolveThreadedSourceTarget(params, requestedTarget);
  const matchesToolContextTarget = getChannelPlugin(params.channel as ChannelId)?.threading
    ?.matchesToolContextTarget;
  if (
    threadPlacement === "match" &&
    (matchesToolContextTarget?.({
      target: requestedTarget,
      toolContext,
    }) ||
      (threadedTarget !== requestedTarget &&
        matchesToolContextTarget?.({
          target: threadedTarget,
          toolContext,
        })))
  ) {
    return true;
  }
  return currentTargets.some(
    (currentTarget) => requestedTarget === currentTarget || threadedTarget === currentTarget,
  );
}

function isExactCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
): params is MirrorableSourceReplyTranscriptParams {
  const threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  );
  return threadPlacement === "match" && isCurrentSourceConversation(params, threadPlacement);
}

/** Confirms that a successful send reached the exact trusted source conversation. */
export function isDeliveredCurrentSourceReply(params: SourceReplyTranscriptMirrorParams): boolean {
  return (
    !hasExplicitDeliveryFailure(params.deliveredPayload) && isExactCurrentSourceConversation(params)
  );
}

// `thread-reply` addresses a thread target and only optionally carries a
// replied-to message id, so the message-id contract below cannot verify it;
// its current-source marking needs thread-placement validation as follow-up.
const CURRENT_SOURCE_REPLY_ACTION_NAMES = new Set(["reply"]);

/** Reply-type message actions address a message id rather than a conversation target. */
export function isCurrentSourceReplyActionName(action: string): boolean {
  return CURRENT_SOURCE_REPLY_ACTION_NAMES.has(action.trim().toLowerCase());
}

function normalizeMessageIdValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

/**
 * Confirms a successful reply-type action addressed the message that triggered the
 * current run. Reply actions resolve their conversation from the replied-to message,
 * so target matching cannot apply; replying to the run's own inbound message is the
 * one implicit route that provably lands in the current source conversation.
 */
export function isDeliveredCurrentSourceReplyAction(
  params: SourceReplyTranscriptMirrorParams,
): boolean {
  if (!isCurrentSourceReplyActionName(params.action)) {
    return false;
  }
  if (hasExplicitDeliveryFailure(params.deliveredPayload)) {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return false;
  }
  const toolContext = params.toolContext;
  if (!toolContext) {
    return false;
  }
  const accountId = normalizeOptionalString(params.accountId);
  if (accountId) {
    const currentAccountId = normalizeOptionalString(params.currentAccountId);
    if (
      !currentAccountId ||
      normalizeAccountId(accountId) !== normalizeAccountId(currentAccountId)
    ) {
      return false;
    }
  }
  const currentChannel = normalizeOptionalLowercaseString(toolContext.currentChannelProvider);
  if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) {
    return false;
  }
  // Target params on reply actions are either agent-explicit or runner-resolved
  // from the tool context; both must still address the current conversation.
  // Delegate equivalence to the channel plugin first so provider-normalized
  // forms (for example `C123` vs `channel:C123`) are recognized like sends.
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (requestedTarget) {
    const matchesToolContextTarget = getChannelPlugin(params.channel as ChannelId)?.threading
      ?.matchesToolContextTarget;
    if (!matchesToolContextTarget?.({ target: requestedTarget, toolContext })) {
      const currentTargets = [
        normalizeOptionalString(toolContext.currentMessagingTarget),
        normalizeOptionalString(toolContext.currentChannelId),
      ].filter((target): target is string => Boolean(target));
      if (!currentTargets.some((target) => target === requestedTarget)) {
        return false;
      }
    }
  }
  const repliedToMessageId = normalizeMessageIdValue(
    params.actionParams.messageId ?? params.actionParams.replyTo,
  );
  const currentMessageId = normalizeMessageIdValue(toolContext.currentMessageId);
  return Boolean(repliedToMessageId && currentMessageId && repliedToMessageId === currentMessageId);
}

/** Mirrors successful outbound source replies into the owning session transcript. */
export async function mirrorDeliveredSourceReplyToTranscript(
  params: SourceReplyTranscriptMirrorParams,
): Promise<boolean> {
  if (hasExplicitDeliveryFailure(params.deliveredPayload)) {
    return false;
  }
  const threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  );
  if (!isCurrentSourceConversation(params, threadPlacement)) {
    return false;
  }
  if (params.sourceReplyFinal === true && threadPlacement !== "match") {
    return false;
  }

  const plan = createOutboundPayloadPlan([
    {
      text: readFirstString(params.actionParams, ["message", "content", "text", "caption"]) ?? "",
      mediaUrl: readFirstString(params.actionParams, [
        "mediaUrl",
        "media",
        "path",
        "filePath",
        "fileUrl",
      ]),
      mediaUrls: readStringArray(params.actionParams.mediaUrls),
      presentation: params.actionParams.presentation as ReplyPayload["presentation"],
      interactive: params.actionParams.interactive as ReplyPayload["interactive"],
      channelData: params.actionParams.channelData as ReplyPayload["channelData"],
    },
  ]);
  const mirror = projectOutboundPayloadPlanForMirror(plan);
  if (!mirror.text && mirror.mediaUrls.length === 0) {
    return false;
  }
  const sourceTurnId = resolveCurrentSourceTurnId(params.toolContext);
  const writerFence = getOwnedSessionTranscriptWriterFence();
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { expectedSessionId: params.sessionId } : {}),
    ...(writerFence?.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
      : {}),
    ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
    text: mirror.text,
    mediaUrls: mirror.mediaUrls.length ? mirror.mediaUrls : undefined,
    idempotencyKey: resolveTranscriptMirrorIdempotencyKey({
      idempotencyKey: params.idempotencyKey,
      sourceReplyFinal: params.sourceReplyFinal,
      sourceTurnId,
    }),
    ...(params.sourceReplyFinal !== undefined
      ? {
          deliveryMirror: {
            kind: "message-tool-source-reply" as const,
            final: params.sourceReplyFinal,
            ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
            ...(sourceTurnId ? { sourceTurnId } : {}),
          },
        }
      : {}),
    config: params.cfg,
  });
  if (result.ok) {
    return true;
  }
  return false;
}
