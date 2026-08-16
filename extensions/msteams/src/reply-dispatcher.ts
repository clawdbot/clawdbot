import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
// Msteams plugin module implements reply dispatcher behavior.
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  normalizeAgentPlanSteps,
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createChannelMessageReplyPipeline,
  logTypingFailure,
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
  type MSTeamsReplyStyle,
  type ReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { resolveMSTeamsSdkCloudOptions } from "./cloud.js";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  buildConversationReference,
  type MSTeamsRenderedMessage,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

export function createMSTeamsReplyDispatcher(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: MSTeamsMonitorLogger;
  app: MSTeamsApp;
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

  // Forward references: sendTypingIndicator is built before the stream
  // controller exists, but the keepalive tick needs to check stream state so
  // we don't overlay "..." typing on the visible streaming card, and we want
  // to suppress typing pulses entirely once the user pressed Stop (otherwise
  // typing keeps pulsing for the rest of the agent run, fighting the cancel
  // signal). Both refs are wired once the stream controller is constructed
  // below.
  const streamActiveRef: { current: () => boolean } = { current: () => false };
  const streamCanceledRef: { current: () => boolean } = { current: () => false };

  const rawSendTypingIndicator = async () => {
    await withRevokedProxyFallback({
      run: async () => {
        await params.context.sendActivity({ type: "typing" });
      },
      onRevoked: async () => {
        const baseRef = buildConversationReference(params.conversationRef);
        await sendMSTeamsActivityWithReference(
          params.app,
          baseRef,
          { type: "typing" },
          { serviceUrlBoundary: resolveMSTeamsSdkCloudOptions(msteamsCfg) },
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
        // Once the user pressed Stop (or Teams ended the stream), suppress
        // typing pulses too — otherwise the bot keeps pulsing "typing..." in
        // Teams for the rest of the agent run, fighting the user's explicit
        // cancel. The agent can't currently be canceled, but it's about to
        // wind down on its own; in the meantime we honor the cancel visually.
        if (streamCanceledRef.current()) {
          return;
        }
        await rawSendTypingIndicator();
      }
    : async () => {};

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    typing: {
      start: sendTypingIndicator,
      keepaliveIntervalMs: TYPING_KEEPALIVE_INTERVAL_MS,
      maxDurationMs: TYPING_KEEPALIVE_MAX_DURATION_MS,
      onStartError: (err: unknown) => {
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
  // Teams native streams are provider-visible before outbound modifiers run. Keep them off
  // whenever a hook can rewrite or cancel so the original payload cannot escape the final gate.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview = !(
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false)
  );
  const streamController = createTeamsReplyStreamController({
    allowProviderPreview,
    conversationType,
    context: params.context,
    feedbackLoopEnabled,
    log: params.log,
    msteamsConfig: msteamsCfg,
    // Stable seed so the same conversation gets a consistent rotating
    // "Thinking..." flavor across reconnects. accountId scopes per-bot,
    // conversation.id scopes per-chat.
    progressSeed: `${params.accountId ?? "default"}:${params.conversationRef.conversation?.id ?? ""}`,
  });
  // Wire the forward-declared gates used by sendTypingIndicator.
  streamActiveRef.current = () => streamController.isStreamActive();
  streamCanceledRef.current = () => streamController.wasCanceled();

  // Resolve block-streaming preference from the canonical nested config
  // (`streaming.mode = "block"` or `streaming.block.enabled = true`); legacy
  // flat `blockStreaming` is migrated by `openclaw doctor --fix`.
  const teamsStreamMode = resolveChannelPreviewStreamMode(msteamsCfg, "partial");
  const blockStreamingResolved =
    teamsStreamMode === "block" ? true : resolveChannelStreamingBlockEnabled(msteamsCfg);
  const blockStreamingEnabled = blockStreamingResolved ?? false;
  const typingIndicatorEnabled =
    typeof msteamsCfg?.typingIndicator === "boolean" ? msteamsCfg.typingIndicator : true;

  type DeliveryOutcome = {
    messageIds?: string[];
    visibleReplySent: boolean;
    content?: string;
  };

  type AcceptedDeliveryPart = {
    messageIds: string[];
    content?: string;
  };

  type PendingDelivery = {
    messages: MSTeamsRenderedMessage[];
    finalization: ReturnType<typeof createDeferred<DeliveryOutcome>>;
    content?: string;
    nativeResult?: AcceptedDeliveryPart;
    blockResults: AcceptedDeliveryPart[];
    native: boolean;
    nativeSettled: boolean;
    blockSettled: boolean;
    settled: boolean;
    errors: unknown[];
  };

  const pendingDeliveries: PendingDelivery[] = [];

  const joinAcceptedContents = (contents: readonly (string | undefined)[]): string =>
    contents.filter((content): content is string => Boolean(content)).join("\n");

  const sendMessages = async (messages: MSTeamsRenderedMessage[]): Promise<string[]> => {
    return sendMSTeamsMessages({
      replyStyle: params.replyStyle,
      app: params.app,
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
      serviceUrlBoundary: resolveMSTeamsSdkCloudOptions(msteamsCfg),
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

  const renderReplyPayload = (payload: ReplyPayload) => {
    return renderReplyPayloadsToMessages([payload], {
      textChunkLimit: params.textLimit,
      chunkText: true,
      mediaMode: "split",
      tableMode,
      chunkMode,
    });
  };

  const deliveryOutcome = (delivery: PendingDelivery): DeliveryOutcome => {
    const acceptedParts = [
      ...(delivery.nativeResult ? [delivery.nativeResult] : []),
      ...delivery.blockResults,
    ];
    const messageIds = acceptedParts.flatMap((part) => part.messageIds);
    const content =
      delivery.errors.length > 0
        ? joinAcceptedContents(acceptedParts.map((part) => part.content))
        : delivery.content;
    return {
      visibleReplySent: acceptedParts.length > 0,
      ...(messageIds.length > 0 ? { messageIds } : {}),
      ...(acceptedParts.length > 0 && content !== undefined ? { content } : {}),
    };
  };

  const settlePendingDelivery = (delivery: PendingDelivery) => {
    if (
      delivery.settled ||
      !delivery.blockSettled ||
      (delivery.native && !delivery.nativeSettled)
    ) {
      return;
    }
    delivery.settled = true;
    const outcome = deliveryOutcome(delivery);
    if (delivery.errors.length === 0) {
      delivery.finalization.resolve(outcome);
      return;
    }

    const error =
      delivery.errors.find(
        (candidate) => !(candidate instanceof PlatformMessageNotDispatchedError),
      ) ?? delivery.errors[0];
    delivery.finalization.reject(
      outcome.visibleReplySent
        ? createChannelPartialDeliveryError(error, {
            ...outcome,
            visibleReplySent: true,
          })
        : error,
    );
  };

  const queueReplyPayload = (
    payload: ReplyPayload,
    messages: MSTeamsRenderedMessage[],
    native: boolean,
  ): PendingDelivery => {
    const finalization = createDeferred<DeliveryOutcome>();
    const delivery: PendingDelivery = {
      messages,
      finalization,
      content: payload.text,
      blockResults: [],
      native,
      nativeSettled: !native,
      blockSettled: messages.length === 0,
      settled: false,
      errors: [],
    };
    pendingDeliveries.push(delivery);
    return delivery;
  };

  const flushPendingMessages = async () => {
    for (const delivery of pendingDeliveries) {
      if (delivery.blockSettled) {
        continue;
      }
      const toSend = delivery.messages.splice(0);
      const total = toSend.length;
      let failed = 0;
      let lastFailedError: unknown;
      const sentIds: string[] = [];
      for (const msg of toSend) {
        try {
          const msgIds = await sendMessages([msg]);
          const validIds = msgIds.filter((id) => id.trim() && id !== "unknown");
          if (msgIds.length > 0) {
            delivery.blockResults.push({
              messageIds: validIds,
              ...(msg.text ? { content: msg.text } : {}),
            });
          }
          sentIds.push(...validIds);
        } catch (msgError) {
          failed += 1;
          lastFailedError = msgError;
          delivery.errors.push(msgError);
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
      delivery.blockSettled = true;
      settlePendingDelivery(delivery);
      if (sentIds.length > 0) {
        try {
          params.onSentMessageIds?.(sentIds);
        } catch (error) {
          params.log.warn?.("failed to record sent Teams message ids", {
            error: formatUnknownError(error),
          });
        }
      }
    }
  };

  const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
    ...replyPipeline,
    humanDelay: resolveHumanDelayConfig(params.cfg, params.agentId),
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
  };
  const delivery: ChannelInboundTurnPlan["delivery"] = {
    observeMessageSent: true,
    deliver: async (payload) => {
      const preparedPayload = streamController.preparePayload(payload);
      const native = streamController.claimNativeDelivery();
      const messages = preparedPayload ? renderReplyPayload(preparedPayload) : [];
      if (!native && messages.length === 0) {
        return {
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        };
      }

      const pending = queueReplyPayload(payload, messages, native);

      // When block streaming is enabled, flush immediately so blocks are
      // delivered progressively instead of batching until markDispatchIdle.
      if (blockStreamingEnabled) {
        await flushPendingMessages();
      }
      settlePendingDelivery(pending);
      return {
        visibleReplySent: false,
        finalization: pending.finalization.promise,
      };
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
  };

  const settleDelivery = async (): Promise<void> => {
    await flushPendingMessages();

    const nativeDelivery = pendingDeliveries.find(
      (candidate) => candidate.native && !candidate.nativeSettled,
    );
    if (!nativeDelivery) {
      await streamController.finalize();
      return;
    }
    let nativeResult;
    try {
      nativeResult = await streamController.finalize();
    } catch (error) {
      nativeDelivery.errors.push(error);
      nativeDelivery.nativeSettled = true;
      settlePendingDelivery(nativeDelivery);
      return;
    }

    if (nativeResult.visibleReplySent) {
      nativeDelivery.nativeResult = {
        messageIds: nativeResult.messageId ? [nativeResult.messageId] : [],
        ...(nativeResult.content !== undefined ? { content: nativeResult.content } : {}),
      };
    }
    const hasPostNativePayloads = Boolean(nativeResult.postNativePayloads?.length);
    if (nativeResult.logicalContent !== undefined) {
      nativeDelivery.content = nativeResult.logicalContent;
    } else if (
      nativeResult.content !== undefined &&
      ((!nativeResult.fallbackPayload && !hasPostNativePayloads) ||
        nativeDelivery.content === undefined)
    ) {
      nativeDelivery.content = nativeResult.content;
    }
    const afterNativePayloads = [
      ...(nativeResult.fallbackPayload ? [nativeResult.fallbackPayload] : []),
      ...(nativeResult.postNativePayloads ?? []),
    ];
    if (afterNativePayloads.length > 0) {
      nativeDelivery.messages.push(
        ...afterNativePayloads.flatMap((payload) => renderReplyPayload(payload)),
      );
      nativeDelivery.blockSettled = nativeDelivery.messages.length === 0;
    }
    nativeDelivery.nativeSettled = true;
    if (!nativeDelivery.blockSettled) {
      await flushPendingMessages();
    }
    settlePendingDelivery(nativeDelivery);
    if (nativeResult.messageId) {
      try {
        params.onSentMessageIds?.([nativeResult.messageId]);
      } catch (error) {
        params.log.warn?.("failed to record sent Teams message id", {
          error: formatUnknownError(error),
        });
      }
    }
  };

  // Pipe agent tool/plan/approval/command events into the stream controller's
  // progress-draft surface. In "progress" stream mode this lets the live
  // streaming card show "Searching the schema..." → "Generating SQL..." as
  // tools fire (instead of the rotating "Thinking..." label sitting unchanged
  // for the duration of a long tool chain). In other modes these calls are
  // no-ops on the controller side.
  const previewToolProgressEnabled = resolveChannelStreamingPreviewToolProgress(
    msteamsCfg,
    true,
    teamsStreamMode,
  );
  const suppressDefaultToolProgressMessages =
    resolveChannelStreamingSuppressDefaultToolProgressMessages(msteamsCfg);
  const shouldSuppressDefaultToolProgressMessages =
    streamController.hasStream() &&
    teamsStreamMode === "progress" &&
    suppressDefaultToolProgressMessages &&
    previewToolProgressEnabled;

  // Forward the rich pipeline event payload through to the channel-streaming
  // formatters. The formatters accept the canonical union shape; the pipeline
  // payload is structurally compatible but tsgo can't see through the
  // optional-property unions for this signature, so we cast at the boundary.
  type PipelinePayload = Record<string, unknown>;

  const progressCallbacks = streamController.hasStream()
    ? {
        onReasoningStream: async (payload: PipelinePayload) => {
          const text = typeof payload?.text === "string" ? payload.text : undefined;
          if (!text) {
            return false;
          }
          if (payload?.isReasoningSnapshot !== true) {
            await streamController.pushProgressLine(text);
            return false;
          }
          await streamController.pushProgressLine(
            buildChannelProgressDraftLine({
              event: "item",
              itemId: "reasoning",
              itemKind: "analysis",
              title: "Reasoning",
              progressText: text,
            }),
          );
          return false;
        },
        onToolStart: async (payload: PipelinePayload) => {
          const name = typeof payload?.name === "string" ? payload.name : undefined;
          const detailMode =
            typeof payload?.detailMode === "string" ? payload.detailMode : undefined;
          await streamController.pushProgressLine(
            buildChannelProgressDraftLineForEntry(
              msteamsCfg,
              {
                event: "tool",
                ...(typeof payload?.itemId === "string" ? { itemId: payload.itemId } : {}),
                ...(typeof payload?.toolCallId === "string"
                  ? { toolCallId: payload.toolCallId }
                  : {}),
                ...(name ? { name } : {}),
                ...(typeof payload?.phase === "string" ? { phase: payload.phase } : {}),
                ...(payload?.args && typeof payload.args === "object"
                  ? { args: payload.args as Record<string, unknown> }
                  : {}),
              },
              detailMode === "explain" || detailMode === "raw" ? { detailMode } : undefined,
            ),
            name ? { toolName: name } : undefined,
          );
          return false;
        },
        onItemEvent: async (payload: PipelinePayload) => {
          await streamController.pushProgressLine(
            buildChannelProgressDraftLineForEntry(msteamsCfg, {
              event: "item",
              ...(typeof payload?.itemId === "string" ? { itemId: payload.itemId } : {}),
              ...(typeof payload?.toolCallId === "string"
                ? { toolCallId: payload.toolCallId }
                : {}),
              ...(typeof payload?.kind === "string" ? { itemKind: payload.kind } : {}),
              ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
              ...(typeof payload?.name === "string" ? { name: payload.name } : {}),
              ...(typeof payload?.phase === "string" ? { phase: payload.phase } : {}),
              ...(typeof payload?.status === "string" ? { status: payload.status } : {}),
              ...(typeof payload?.summary === "string" ? { summary: payload.summary } : {}),
              ...(typeof payload?.progressText === "string"
                ? { progressText: payload.progressText }
                : {}),
              ...(typeof payload?.meta === "string" ? { meta: payload.meta } : {}),
            }),
          );
          return false;
        },
        onPlanUpdate: async (payload: PipelinePayload) => {
          if (payload?.phase !== "update") {
            return false;
          }
          await streamController.pushPlanProgress(normalizeAgentPlanSteps(payload.steps), {
            explanation: typeof payload.explanation === "string" ? payload.explanation : undefined,
          });
          return false;
        },
        onApprovalEvent: async (payload: PipelinePayload) => {
          if (payload?.phase !== "requested") {
            return false;
          }
          await streamController.pushProgressLine(
            buildChannelProgressDraftLine({
              event: "approval",
              phase: payload.phase as string,
              ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
              ...(typeof payload?.command === "string" ? { command: payload.command } : {}),
              ...(typeof payload?.reason === "string" ? { reason: payload.reason } : {}),
              ...(typeof payload?.message === "string" ? { message: payload.message } : {}),
            }),
          );
          return false;
        },
        onCommandOutput: async (payload: PipelinePayload) => {
          if (payload?.phase !== "end") {
            return false;
          }
          await streamController.pushProgressLine(
            buildChannelProgressDraftLineForEntry(msteamsCfg, {
              event: "command-output",
              ...(typeof payload?.itemId === "string" ? { itemId: payload.itemId } : {}),
              ...(typeof payload?.toolCallId === "string"
                ? { toolCallId: payload.toolCallId }
                : {}),
              phase: payload.phase as string,
              ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
              ...(typeof payload?.name === "string" ? { name: payload.name } : {}),
              ...(typeof payload?.status === "string" ? { status: payload.status } : {}),
              ...(typeof payload?.exitCode === "number" ? { exitCode: payload.exitCode } : {}),
            }),
          );
          return false;
        },
        onPatchSummary: async (payload: PipelinePayload) => {
          if (payload?.phase !== "end") {
            return false;
          }
          await streamController.pushProgressLine(
            buildChannelProgressDraftLine({
              event: "patch",
              ...(typeof payload?.itemId === "string" ? { itemId: payload.itemId } : {}),
              ...(typeof payload?.toolCallId === "string"
                ? { toolCallId: payload.toolCallId }
                : {}),
              phase: payload.phase as string,
              ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
              ...(typeof payload?.name === "string" ? { name: payload.name } : {}),
              ...(Array.isArray(payload?.added) &&
              payload.added.every((s: unknown) => typeof s === "string")
                ? { added: payload.added }
                : {}),
              ...(Array.isArray(payload?.modified) &&
              payload.modified.every((s: unknown) => typeof s === "string")
                ? { modified: payload.modified }
                : {}),
              ...(Array.isArray(payload?.deleted) &&
              payload.deleted.every((s: unknown) => typeof s === "string")
                ? { deleted: payload.deleted }
                : {}),
              ...(typeof payload?.summary === "string" ? { summary: payload.summary } : {}),
            }),
          );
          return false;
        },
      }
    : {};

  return {
    dispatcherOptions: {
      ...dispatcherOptions,
      onSettled: settleDelivery,
    },
    delivery,
    replyOptions: {
      ...(streamController.hasStream()
        ? {
            onPartialReply: (payload: { text?: string }) => {
              streamController.onPartialReply(payload);
              return false;
            },
          }
        : {}),
      ...progressCallbacks,
      // When progress mode is active, suppress openclaw's default block-style
      // tool-progress messages so they don't duplicate alongside the
      // streaming card's progress lines.
      ...(shouldSuppressDefaultToolProgressMessages
        ? { suppressDefaultToolProgressMessages: true }
        : {}),
      // Pass-through to the reply pipeline. `false` = "use block streaming"
      // (the default when streaming.mode=block or streaming.block.enabled=true).
      // `true` = "do not use it".
      // `undefined` = "no preference" — let the pipeline decide.
      disableBlockStreaming: blockStreamingResolved == null ? undefined : !blockStreamingResolved,
      onModelSelected,
    },
  };
}
