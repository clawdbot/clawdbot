import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { hasInboundAudio } from "../../auto-reply/reply/inbound-media.js";
import { emitMessageReceivedHooks } from "../../auto-reply/reply/message-received-hooks.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings-runtime.js";
import {
  abortReplyMessageInjectionTarget,
  beginReplyMessageInjectionTarget,
  recordAcceptedReplyMessageInjectionTarget,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logMessageProcessed, logMessageReceived } from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { broadcastChatFinal } from "./chat-broadcast.js";
import { buildChatSendReplyInjectionText } from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import type { GatewayRequestContext } from "./types.js";

/** Captures the prepared request data used by both pre-ACK and detached injection attempts. */
export function createChatSendMessageInjectionStarter(params: {
  target: ReplyMessageInjectionTarget | undefined;
  request: Pick<NormalizedChatSendRequest, "p" | "rawMessage" | "supportsTaskSuggestions">;
  session: Pick<PreparedChatSendSession, "cfg" | "entry">;
  turn: ReturnType<typeof prepareChatSendUserTurn>;
  imageOrder: ReplyBackendQueueMessageOptions["imageOrder"];
  userTurnTranscriptRecorder: ReplyBackendQueueMessageOptions["userTurnTranscriptRecorder"];
}) {
  const { p, rawMessage, supportsTaskSuggestions } = params.request;
  const { cfg, entry } = params.session;
  const { ctx, isInternalTextSlashCommandTurn, replyOptionImages, replyOptionMedia } = params.turn;
  return (): ReplyMessageInjectionAttempt | undefined => {
    if (!params.target || isInternalTextSlashCommandTurn) {
      return undefined;
    }
    const { debounceMs } = resolveQueueSettings({
      cfg,
      channel: ctx.Provider,
      sessionEntry: entry,
      inlineMode: p.queueMode,
    });
    const text = ctx.BodyForAgent ?? ctx.Body ?? rawMessage;
    return beginReplyMessageInjectionTarget(
      params.target,
      p.replyToId
        ? buildChatSendReplyInjectionText({ body: text, cfg, ctx, sessionEntry: entry })
        : text,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(replyOptionImages?.length ? { images: replyOptionImages } : {}),
        ...(params.imageOrder?.length ? { imageOrder: params.imageOrder } : {}),
        ...(replyOptionMedia?.length ? { media: replyOptionMedia } : {}),
        waitForTranscriptCommit: true,
        ...(debounceMs !== undefined ? { debounceMs } : {}),
        taskSuggestionDeliveryMode: supportsTaskSuggestions ? "gateway" : undefined,
        userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
      },
    );
  };
}

type PreAckMessageInjectionResult =
  | { status: "continue"; attempt: ReplyMessageInjectionAttempt | undefined }
  | { status: "handled" };

/** Wait for runtime ownership before ACK without waiting for transcript commitment. */
export async function settleChatSendPreAckMessageInjection(params: {
  attempt: ReplyMessageInjectionAttempt | undefined;
  isAborted: () => boolean;
  sessionRoutingChanged: () => boolean;
  onActiveLeafChanged: () => Promise<void>;
  onAborted: () => void;
  onSessionRoutingChanged: () => void;
}): Promise<PreAckMessageInjectionResult> {
  if (params.attempt?.rejectBeforeAck) {
    await params.onActiveLeafChanged();
    return { status: "handled" };
  }
  if (!params.attempt || (await params.attempt.acceptance)) {
    return { status: "continue", attempt: params.attempt };
  }
  if (params.isAborted()) {
    params.onAborted();
    return { status: "handled" };
  }
  if (params.sessionRoutingChanged()) {
    params.onSessionRoutingChanged();
    return { status: "handled" };
  }
  return { status: "continue", attempt: undefined };
}

/** Finish an irrevocably accepted steer without entering reply dispatch. */
export async function finalizeAcceptedChatSendMessageInjection(params: {
  context: GatewayRequestContext;
  ctx: RuntimeMsgContext;
  outcome: Extract<ReplyMessageInjectionOutcome, { status: "accepted" }>;
  persistUserTurnTranscriptBestEffort: () => Promise<void>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "cfg" | "clientRunId" | "entry" | "sessionKey" | "storePath"
  >;
  startedAt: number;
  target: ReplyMessageInjectionTarget;
  targetRunId: string | undefined;
}): Promise<void> {
  const { context, ctx, outcome, session, target } = params;
  const { agentId, cfg, clientRunId, entry, sessionKey, storePath } = session;
  const finalizedCtx = finalizeInboundContext(ctx);
  const channel = normalizeLowercaseStringOrEmpty(
    finalizedCtx.Surface ?? finalizedCtx.Provider ?? "unknown",
  );
  const chatId = finalizedCtx.To ?? finalizedCtx.From;
  const messageId =
    finalizedCtx.MessageSidFull ??
    finalizedCtx.MessageSid ??
    finalizedCtx.MessageSidFirst ??
    finalizedCtx.MessageSidLast;
  recordAcceptedReplyMessageInjectionTarget(target, {
    inboundAudio: hasInboundAudio(finalizedCtx),
  });
  if (outcome.result?.transcriptCommit === "unconfirmed") {
    abortReplyMessageInjectionTarget(target);
    context.logGateway.warn(
      `active run ${params.targetRunId ?? "unknown"} accepted chat steering without transcript confirmation; aborted exact target without replay`,
    );
  }
  await params.persistUserTurnTranscriptBestEffort();
  if (isDiagnosticsEnabled(cfg)) {
    logMessageReceived({
      sessionKey,
      channel,
      chatId,
      messageId,
      source: "dispatchInboundMessage",
    });
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionId: entry?.sessionId,
      sessionKey,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      outcome: "completed",
      reason: "active_run_injected",
    });
  }
  emitMessageReceivedHooks({
    ctx: finalizedCtx,
    hookRunner: getGlobalHookRunner(),
    sessionKey,
    timestamp:
      typeof finalizedCtx.Timestamp === "number" && Number.isFinite(finalizedCtx.Timestamp)
        ? finalizedCtx.Timestamp
        : undefined,
  });
  emitInboundMessageAuditTerminal({
    cfg,
    counts: { tool: 0, block: 0, final: 0 },
    ctx: finalizedCtx,
    observedRunId: clientRunId,
    startedAt: params.startedAt,
    terminal: { outcome: "completed", options: { reason: "active_run_injected" } },
  });
  const updatedAt = Date.now();
  if (entry) {
    entry.updatedAt = updatedAt;
  }
  await updateSessionEntry({ storePath, sessionKey }, () => ({ updatedAt }), {
    skipMaintenance: true,
    takeCacheOwnership: true,
  }).catch((error: unknown) => {
    context.logGateway.warn(`failed to touch session after accepted steering: ${String(error)}`);
  });
  if (!context.chatRunState.hasAbortMarker(clientRunId)) {
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: {
        ts: Date.now(),
        ok: true,
        payload: { runId: clientRunId, status: "ok" as const },
      },
    });
    broadcastChatFinal({ context, runId: clientRunId, sessionKey, agentId });
  }
}
