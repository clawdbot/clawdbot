import {
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-streaming";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  createChannelReplyPipeline,
  logTypingFailure,
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
  type MSTeamsReplyStyle,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  buildConversationReference,
  type MSTeamsAdapter,
  type MSTeamsRenderedMessage,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export { pickInformativeStatusText } from "./reply-stream-controller.js";

export function createMSTeamsReplyDispatcher(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: MSTeamsMonitorLogger;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context: MSTeamsTurnContext;
  replyStyle: MSTeamsReplyStyle;
  textLimit: number;
  onSentMessageIds?: (ids: string[]) => void;
  tokenProvider?: MSTeamsAccessTokenProvider;
  sharePointSiteId?: string;
}) {
  const core = getMSTeamsRuntime();
  const msteamsCfg = params.cfg.channels?.msteams;
  const conversationType = normalizeOptionalLowercaseString(
    params.conversationRef.conversation?.conversationType,
  );
  const isTypingSupported = conversationType === "personal" || conversationType === "groupchat";

  /**
   * Keepalive cadence for the typing indicator while the bot is running
   * (including long tool chains). Bot Framework 1:1 TurnContext proxies
   * expire after ~30s of inactivity; sending a typing activity every 8s
   * keeps the proxy alive so the post-tool reply can still land via the
   * turn context. Sits in the middle of the 5-10s range recommended in
   * #59731.
   */
  const TYPING_KEEPALIVE_INTERVAL_MS = 8_000;

  /**
   * TTL ceiling for the typing keepalive loop. The default in
   * createTypingCallbacks is 60s, which is too short for the Teams long tool
   * chains described in #59731 (60s+ total runs are common). Give tool
   * chains up to 10 minutes before auto-stopping the keepalive.
   */
  const TYPING_KEEPALIVE_MAX_DURATION_MS = 10 * 60_000;

  // Forward reference: sendTypingIndicator is built before the stream
  // controller exists, but the keepalive tick needs to check stream state so
  // we don't overlay "..." typing on the visible streaming card. The ref is
  // wired once the stream controller is constructed below.
  const streamActiveRef: { current: () => boolean } = { current: () => false };

  const rawSendTypingIndicator = async () => {
    await withRevokedProxyFallback({
      run: async () => {
        await params.context.sendActivity({ type: "typing" });
      },
      onRevoked: async () => {
        const baseRef = buildConversationReference(params.conversationRef);
        await params.adapter.continueConversation(
          params.appId,
          { ...baseRef, activityId: undefined },
          async (ctx) => {
            await ctx.sendActivity({ type: "typing" });
          },
        );
      },
      onRevokedLog: () => {
        params.log.debug?.("turn context revoked, sending typing via proactive messaging");
      },
    });
  };

  const sendTypingIndicator = isTypingSupported
    ? async () => {
        // While the streaming card is actively being updated the user
        // already sees a live indicator in the stream — don't overlay a
        // plain "..." typing on top of it. Between segments (tool chain)
        // the stream is finalized, so typing indicators are appropriate
        // and they are what keep the TurnContext alive. See #59731.
        if (streamActiveRef.current()) {
          return;
        }
        await rawSendTypingIndicator();
      }
    : async () => {};

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    typing: {
      start: sendTypingIndicator,
      keepaliveIntervalMs: TYPING_KEEPALIVE_INTERVAL_MS,
      maxDurationMs: TYPING_KEEPALIVE_MAX_DURATION_MS,
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => params.log.debug?.(message),
          channel: "msteams",
          action: "start",
          error: err,
        });
      },
    },
  });

  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "msteams",
  });
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb,
  });
  const feedbackLoopEnabled = params.cfg.channels?.msteams?.feedbackEnabled !== false;
  const streamController = createTeamsReplyStreamController({
    conversationType,
    context: params.context,
    feedbackLoopEnabled,
    log: params.log,
    msteamsConfig: msteamsCfg,
    progressSeed: `${params.accountId ?? "default"}:${params.conversationRef.conversation?.id ?? ""}`,
  });
  // Wire the forward-declared gate used by sendTypingIndicator.
  streamActiveRef.current = () => streamController.isStreamActive();

  const teamsStreamMode = resolveChannelPreviewStreamMode(msteamsCfg, "partial");
  const resolvedBlockStreamingEnabled =
    teamsStreamMode === "block" ? true : resolveChannelStreamingBlockEnabled(msteamsCfg);
  const blockStreamingEnabled = resolvedBlockStreamingEnabled ?? false;
  const typingIndicatorEnabled =
    typeof msteamsCfg?.typingIndicator === "boolean" ? msteamsCfg.typingIndicator : true;

  const pendingMessages: MSTeamsRenderedMessage[] = [];

  const sendMessages = async (messages: MSTeamsRenderedMessage[]): Promise<string[]> => {
    return sendMSTeamsMessages({
      replyStyle: params.replyStyle,
      adapter: params.adapter,
      appId: params.appId,
      conversationRef: params.conversationRef,
      context: params.context,
      messages,
      retry: {},
      onRetry: (event) => {
        params.log.debug?.("retrying send", {
          replyStyle: params.replyStyle,
          ...event,
        });
      },
      tokenProvider: params.tokenProvider,
      sharePointSiteId: params.sharePointSiteId,
      mediaMaxBytes,
      feedbackLoopEnabled,
    });
  };

  const queueDeliveryFailureSystemEvent = (failure: {
    failed: number;
    total: number;
    error: unknown;
  }) => {
    const classification = classifyMSTeamsSendError(failure.error);
    const errorText = formatUnknownError(failure.error);
    const failedAll = failure.failed >= failure.total;
    const summary = failedAll
      ? "the previous reply was not delivered"
      : `${failure.failed} of ${failure.total} message blocks were not delivered`;
    const sentences = [
      `Microsoft Teams delivery failed: ${summary}.`,
      `The user may not have received ${failedAll ? "that reply" : "the full reply"}.`,
      `Error: ${errorText}.`,
      classification.statusCode != null ? `Status: ${classification.statusCode}.` : undefined,
      classification.kind === "transient" || classification.kind === "throttled"
        ? "Retrying later may succeed."
        : undefined,
    ].filter(Boolean);
    core.system.enqueueSystemEvent(sentences.join(" "), {
      sessionKey: params.sessionKey,
      contextKey: `msteams:delivery-failure:${params.conversationRef.conversation?.id ?? "unknown"}`,
    });
  };

  const flushPendingMessages = async () => {
    if (pendingMessages.length === 0) {
      return;
    }
    const toSend = pendingMessages.splice(0);
    const total = toSend.length;
    let ids: string[];
    try {
      ids = await sendMessages(toSend);
    } catch (batchError) {
      ids = [];
      let failed = 0;
      let lastFailedError: unknown = batchError;
      for (const msg of toSend) {
        try {
          const msgIds = await sendMessages([msg]);
          ids.push(...msgIds);
        } catch (msgError) {
          failed += 1;
          lastFailedError = msgError;
          params.log.debug?.("individual message send failed, continuing with remaining blocks");
        }
      }
      if (failed > 0) {
        params.log.warn?.(`failed to deliver ${failed} of ${total} message blocks`, {
          failed,
          total,
        });
        queueDeliveryFailureSystemEvent({
          failed,
          total,
          error: lastFailedError,
        });
      }
    }
    if (ids.length > 0) {
      params.onSentMessageIds?.(ids);
    }
  };

  const {
    dispatcher,
    replyOptions,
    markDispatchIdle: baseMarkDispatchIdle,
  } = core.channel.reply.createReplyDispatcherWithTyping({
    ...replyPipeline,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
    onReplyStart: async () => {
      await streamController.onReplyStart();
      // Always start the typing keepalive loop when typing is enabled and
      // supported by this conversation type. The sendTypingIndicator gate
      // skips actual sends while the stream card is visually active, so
      // during the first text segment the user only sees the streaming UI.
      // Once the stream finalizes (between segments / during tool chains),
      // the loop starts sending typing activities and keeps the Bot Framework
      // TurnContext alive so the post-tool reply can still land. See #59731.
      if (typingIndicatorEnabled) {
        await typingCallbacks?.onReplyStart?.();
      }
    },
    typingCallbacks,
    deliver: async (payload) => {
      const preparedPayload = await streamController.preparePayload(payload);
      if (!preparedPayload) {
        return;
      }

      const messages = renderReplyPayloadsToMessages([preparedPayload], {
        textChunkLimit: params.textLimit,
        chunkText: true,
        mediaMode: "split",
        tableMode,
        chunkMode,
      });
      pendingMessages.push(...messages);

      // When block streaming is enabled, flush immediately so blocks are
      // delivered progressively instead of batching until markDispatchIdle.
      if (blockStreamingEnabled) {
        await flushPendingMessages();
      }
    },
    onError: (err, info) => {
      const errMsg = formatUnknownError(err);
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      params.runtime.error?.(
        `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`,
      );
      params.log.error("reply failed", {
        kind: info.kind,
        error: errMsg,
        classification,
        hint,
      });
    },
  });

  const markDispatchIdle = (): Promise<void> => {
    return flushPendingMessages()
      .catch((err) => {
        const errMsg = formatUnknownError(err);
        const classification = classifyMSTeamsSendError(err);
        const hint = formatMSTeamsSendErrorHint(classification);
        params.runtime.error?.(`msteams flush reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
        params.log.error("flush reply failed", {
          error: errMsg,
          classification,
          hint,
        });
      })
      .then(() => {
        return streamController.finalize().catch((err) => {
          params.log.debug?.("stream finalize failed", { error: formatUnknownError(err) });
        });
      })
      .finally(() => {
        baseMarkDispatchIdle();
      });
  };

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      ...(streamController.hasStream()
        ? {
            onPartialReply: (payload: { text?: string }) =>
              streamController.onPartialReply(payload),
            onToolStart: async (payload: { name?: string }) => {
              await streamController.noteProgressWork({ toolName: payload.name });
            },
            onItemEvent: async () => {
              await streamController.noteProgressWork();
            },
            onPlanUpdate: async (payload: { phase?: string }) => {
              if (payload.phase === "update") {
                await streamController.noteProgressWork();
              }
            },
            onApprovalEvent: async (payload: { phase?: string }) => {
              if (payload.phase === "requested") {
                await streamController.noteProgressWork();
              }
            },
            onCommandOutput: async (payload: { phase?: string }) => {
              if (payload.phase === "end") {
                await streamController.noteProgressWork();
              }
            },
            onPatchSummary: async (payload: { phase?: string }) => {
              if (payload.phase === "end") {
                await streamController.noteProgressWork();
              }
            },
          }
        : {}),
      ...(streamController.shouldSuppressDefaultToolProgressMessages()
        ? { suppressDefaultToolProgressMessages: true }
        : {}),
      ...(streamController.shouldStreamPreviewToolProgress()
        ? {
            onToolStart: async (payload: {
              name?: string;
              phase?: string;
              args?: Record<string, unknown>;
              detailMode?: "explain" | "raw";
            }) => {
              await streamController.pushProgressLine(
                formatChannelProgressDraftLineForEntry(
                  msteamsCfg,
                  {
                    event: "tool",
                    name: payload.name,
                    phase: payload.phase,
                    args: payload.args,
                  },
                  payload.detailMode ? { detailMode: payload.detailMode } : undefined,
                ),
                { toolName: payload.name },
              );
            },
            onItemEvent: async (payload: {
              kind?: string;
              progressText?: string;
              meta?: string;
              summary?: string;
              title?: string;
              name?: string;
              phase?: string;
              status?: string;
            }) => {
              await streamController.pushProgressLine(
                formatChannelProgressDraftLineForEntry(msteamsCfg, {
                  event: "item",
                  itemKind: payload.kind,
                  title: payload.title,
                  name: payload.name,
                  phase: payload.phase,
                  status: payload.status,
                  summary: payload.summary,
                  progressText: payload.progressText,
                  meta: payload.meta,
                }),
              );
            },
            onPlanUpdate: async (payload: {
              phase?: string;
              title?: string;
              explanation?: string;
              steps?: string[];
            }) => {
              if (payload.phase !== "update") {
                return;
              }
              await streamController.pushProgressLine(
                formatChannelProgressDraftLine({
                  event: "plan",
                  phase: payload.phase,
                  title: payload.title,
                  explanation: payload.explanation,
                  steps: payload.steps,
                }),
              );
            },
            onApprovalEvent: async (payload: {
              phase?: string;
              title?: string;
              command?: string;
              reason?: string;
              message?: string;
            }) => {
              if (payload.phase !== "requested") {
                return;
              }
              await streamController.pushProgressLine(
                formatChannelProgressDraftLine({
                  event: "approval",
                  phase: payload.phase,
                  title: payload.title,
                  command: payload.command,
                  reason: payload.reason,
                  message: payload.message,
                }),
              );
            },
            onCommandOutput: async (payload: {
              phase?: string;
              title?: string;
              name?: string;
              status?: string;
              exitCode?: number | null;
            }) => {
              if (payload.phase !== "end") {
                return;
              }
              await streamController.pushProgressLine(
                formatChannelProgressDraftLine({
                  event: "command-output",
                  phase: payload.phase,
                  title: payload.title,
                  name: payload.name,
                  status: payload.status,
                  exitCode: payload.exitCode,
                }),
              );
            },
            onPatchSummary: async (payload: {
              phase?: string;
              summary?: string;
              title?: string;
              name?: string;
              added?: string[];
              modified?: string[];
              deleted?: string[];
            }) => {
              if (payload.phase !== "end") {
                return;
              }
              await streamController.pushProgressLine(
                formatChannelProgressDraftLine({
                  event: "patch",
                  phase: payload.phase,
                  title: payload.title,
                  name: payload.name,
                  added: payload.added,
                  modified: payload.modified,
                  deleted: payload.deleted,
                  summary: payload.summary,
                }),
              );
            },
          }
        : {}),
      disableBlockStreaming:
        typeof resolvedBlockStreamingEnabled === "boolean"
          ? !resolvedBlockStreamingEnabled
          : undefined,
      onModelSelected,
    },
    markDispatchIdle,
  };
}
