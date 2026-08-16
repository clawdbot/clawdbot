import type { StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
// Discord plugin module owns progress-window state and agent-event rendering.
import { createChannelProgressReceiptTracker } from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

type ReplyOptions = Omit<GetReplyOptions, "onBlockReply">;
type CallbackPayload<K extends keyof ReplyOptions> =
  NonNullable<ReplyOptions[K]> extends (...args: infer Args) => unknown ? Args[0] : never;
type DraftPreview = ReturnType<typeof createDiscordDraftPreviewController>;

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isFailedProgress(payload: {
  phase?: string;
  status?: string;
  exitCode?: number | null;
}): boolean {
  return (
    payload.phase === "error" ||
    payload.status === "failed" ||
    payload.status === "error" ||
    (typeof payload.exitCode === "number" && payload.exitCode !== 0)
  );
}

export function createDiscordMessageProgressRuntime(params: {
  ctx: DiscordMessagePreflightContext;
  sessionKey?: string;
  sourceRepliesAreToolOnly: boolean;
  draftPreview: DraftPreview;
  reactions: {
    statusReactionsExplicitlyEnabled: boolean;
    statusReactionsEnabled: boolean;
    readonly controller: StatusReactionController;
    maybeBindToToolReaction: (payload: CallbackPayload<"onToolStart">) => Promise<void>;
  };
  onTurnReset: () => void;
}) {
  const { ctx, draftPreview } = params;
  const { cfg, route, abortSignal } = ctx;
  // Reasoning delivery follows the session /reasoning level, not streaming config.
  const reasoningLevel = ((): "on" | "stream" | "off" => {
    const normalizedAgentId = (route.agentId ?? "").trim().toLowerCase() || "main";
    const agentEntryDefault = cfg.agents?.list?.find(
      (entry) => ((entry?.id ?? "").trim().toLowerCase() || "main") === normalizedAgentId,
    )?.reasoningDefault;
    const cfgDefault = agentEntryDefault ?? cfg.agents?.defaults?.reasoningDefault;
    const configDefault: "on" | "stream" | "off" =
      cfgDefault === "on" || cfgDefault === "stream" ? cfgDefault : "off";
    if (!params.sessionKey) {
      return configDefault;
    }
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
      const level = getSessionEntry({
        agentId: route.agentId,
        sessionKey: params.sessionKey,
        storePath,
      })?.reasoningLevel;
      if (level === "on" || level === "stream" || level === "off") {
        return level;
      }
    } catch {
      return "off";
    }
    return configDefault;
  })();
  const reasoningDurableEnabled = reasoningLevel === "on";
  const reasoningWindowEnabled = reasoningLevel === "stream";
  // The durable verbose lane mirrors commentary, not tool lifecycle rows.
  // Yield only the draft content that has a durable counterpart.
  let shouldYieldDraftCommentary: () => boolean = () => false;
  const progressReceipt = createChannelProgressReceiptTracker();
  const resetTurnState = () => {
    progressReceipt.reset();
  };
  const handleAssistantMessageBoundary = () => {
    if (draftPreview.handleAssistantMessageBoundary()) {
      resetTurnState();
      params.onTurnReset();
    }
  };
  const buildProgressSummaryLine = () => `-# ${progressReceipt.buildSummaryLine()}`;

  const replyOptions: Partial<ReplyOptions> = {
    onAssistantMessageStart: draftPreview.draftStream
      ? () => {
          handleAssistantMessageBoundary();
          return false;
        }
      : undefined,
    onReasoningEnd: draftPreview.draftStream
      ? () => {
          progressReceipt.closeReasoning();
          handleAssistantMessageBoundary();
          return false;
        }
      : undefined,
    onQueuedFollowupAdmitted: draftPreview.draftStream
      ? () => {
          if (draftPreview.handleQueuedFollowupAdmitted()) {
            resetTurnState();
            params.onTurnReset();
          }
        }
      : undefined,
    suppressDefaultToolProgressMessages:
      (params.sourceRepliesAreToolOnly && params.reactions.statusReactionsExplicitlyEnabled) ||
      draftPreview.suppressDefaultToolProgressMessages
        ? true
        : undefined,
    allowToolLifecycleWhenProgressHidden: params.reactions.statusReactionsEnabled
      ? true
      : undefined,
    commentaryProgressEnabled: draftPreview.isProgressMode
      ? draftPreview.commentaryProgressEnabled
      : undefined,
    progressPreambleEnabled:
      draftPreview.draftStream && draftPreview.isProgressMode ? true : undefined,
    commentaryPayloadsEnabled: draftPreview.isProgressMode
      ? draftPreview.commentaryProgressEnabled
      : undefined,
    shouldDeliverCommentaryPayloads:
      draftPreview.isProgressMode && draftPreview.commentaryProgressEnabled
        ? () => shouldYieldDraftCommentary()
        : undefined,
    reasoningPayloadsEnabled: reasoningDurableEnabled,
    onVerboseProgressVisibility: (isActive) => {
      shouldYieldDraftCommentary = isActive;
    },
    onNarrationUpdate: draftPreview.narrationProgressEnabled
      ? async (payload) => {
          if (isProcessAborted(abortSignal) || shouldYieldDraftCommentary()) {
            return;
          }
          await draftPreview.pushNarrationProgress(payload.text);
        }
      : undefined,
    onProgressNarratorLifecycle: draftPreview.narrationProgressEnabled
      ? (lifecycle) => draftPreview.setProgressNarratorLifecycle(lifecycle)
      : undefined,
    isProgressDraftVisible: draftPreview.narrationProgressEnabled
      ? () => draftPreview.isProgressDraftVisible
      : undefined,
    narrationHideCommandText: draftPreview.narrationHideCommandText ? true : undefined,
    onReasoningStream: async (payload) => {
      if (payload?.requiresReasoningProgressOptIn === true && !reasoningWindowEnabled) {
        return false;
      }
      if (payload?.text) {
        progressReceipt.noteReasoning();
      }
      await params.reactions.controller.setThinking();
      return await draftPreview.pushReasoningProgress(payload?.text, {
        snapshot: payload?.isReasoningSnapshot === true,
      });
    },
    streamReasoningInNonStreamModes: reasoningWindowEnabled,
    onToolStart: async (payload) => {
      if (isProcessAborted(abortSignal)) {
        return false;
      }
      await params.reactions.maybeBindToToolReaction(payload);
      await params.reactions.controller.setTool(payload.name);
      if (payload.phase === "start") {
        progressReceipt.noteToolCall(payload.name);
      }
      return await draftPreview.pushToolEvent(payload);
    },
    onItemEvent: async (payload) => {
      if (isFailedProgress(payload)) {
        return false;
      }
      if (payload.kind === "preamble") {
        if (shouldYieldDraftCommentary()) {
          return undefined;
        }
        return await draftPreview.pushPreambleItemEvent(payload, (itemId, text) => {
          progressReceipt.noteCommentary(itemId, text);
        });
      }
      return await draftPreview.pushItemEvent(payload);
    },
    onPlanUpdate: async (payload) => {
      if (payload.phase === "update") {
        return await draftPreview.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
        });
      }
      return false;
    },
    onApprovalEvent: async (payload) => {
      return await draftPreview.pushApprovalEvent(payload);
    },
    onCommandOutput: async (payload) => {
      if (isFailedProgress(payload)) {
        return false;
      }
      return await draftPreview.pushCommandOutputEvent(payload);
    },
    onPatchSummary: async (payload) => {
      return await draftPreview.pushPatchEvent(payload);
    },
    onCompactionStart: async () => {
      if (!isProcessAborted(abortSignal)) {
        await params.reactions.controller.setCompacting();
      }
      return false;
    },
    onCompactionEnd: async () => {
      if (!isProcessAborted(abortSignal)) {
        params.reactions.controller.cancelPending();
        await params.reactions.controller.setThinking();
      }
      return false;
    },
  };

  return {
    replyOptions,
    buildProgressSummaryLine,
  };
}
