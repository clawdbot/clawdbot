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
import { setGatewayDedupeEntry } from "./agent-job.js";
import { broadcastChatFinal } from "./chat-broadcast.js";
import { buildChatSendReplyInjectionText } from "./chat-send-reply-context.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

/** Starts injection with the exact admission-captured target and prepared turn data. */
export function beginChatSendMessageInjection(params: {
  target: ReplyMessageInjectionTarget;
  text: string;
  replyContext?: Parameters<typeof buildChatSendReplyInjectionText>[0];
  images: ReplyBackendQueueMessageOptions["images"];
  imageOrder: ReplyBackendQueueMessageOptions["imageOrder"];
  media: ReplyBackendQueueMessageOptions["media"];
  queueSettings: Parameters<typeof resolveQueueSettings>[0];
  taskSuggestionDeliveryMode: ReplyBackendQueueMessageOptions["taskSuggestionDeliveryMode"];
  userTurnTranscriptRecorder: ReplyBackendQueueMessageOptions["userTurnTranscriptRecorder"];
}): ReplyMessageInjectionAttempt {
  const { debounceMs } = resolveQueueSettings(params.queueSettings);
  return beginReplyMessageInjectionTarget(
    params.target,
    params.replyContext ? buildChatSendReplyInjectionText(params.replyContext) : params.text,
    {
      steeringMode: "all",
      isInboundUserMessage: true,
      ...(params.images?.length ? { images: params.images } : {}),
      ...(params.imageOrder?.length ? { imageOrder: params.imageOrder } : {}),
      ...(params.media?.length ? { media: params.media } : {}),
      waitForTranscriptCommit: true,
      ...(debounceMs !== undefined ? { debounceMs } : {}),
      taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    },
  );
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
