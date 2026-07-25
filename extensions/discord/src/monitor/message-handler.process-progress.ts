import type { StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
// Discord plugin module owns progress-window state and agent-event rendering.
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
} from "openclaw/plugin-sdk/channel-outbound";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

type ReplyOptions = NonNullable<ChannelInboundTurnPlan["replyOptions"]>;
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
  const { cfg, discordConfig, route, abortSignal } = ctx;
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
  let shouldYieldDraftProgress: () => boolean = () => false;
  let progressTurnStartedAt = Date.now();
  let progressReasoningSteps = 0;
  let progressToolCalls = 0;
  let progressCommentaryNotes = 0;
  // Preamble updates can re-fire; count each item id or id-less text once.
  const seenCommentaryIds = new Set<string>();
  let lastCommentaryNoteText = "";
  const noteWindowCommentary = (itemId?: string, noteText?: string) => {
    const trimmed = noteText?.trim();
    if (!trimmed) {
      return;
    }
    if (itemId) {
      if (seenCommentaryIds.has(itemId)) {
        return;
      }
      seenCommentaryIds.add(itemId);
      progressCommentaryNotes += 1;
      return;
    }
    if (trimmed !== lastCommentaryNoteText) {
      lastCommentaryNoteText = trimmed;
      progressCommentaryNotes += 1;
    }
  };
  // DeepSeek does not always emit a thinking_end, so tool/final boundaries also close bursts.
  let windowReasoningOpen = false;
  const closePendingWindowThought = () => {
    if (windowReasoningOpen) {
      windowReasoningOpen = false;
      progressReasoningSteps += 1;
    }
  };
  const resetTurnState = () => {
    progressTurnStartedAt = Date.now();
    progressReasoningSteps = 0;
    progressToolCalls = 0;
    progressCommentaryNotes = 0;
    seenCommentaryIds.clear();
    lastCommentaryNoteText = "";
    windowReasoningOpen = false;
  };
  const handleAssistantMessageBoundary = () => {
    if (draftPreview.handleAssistantMessageBoundary()) {
      resetTurnState();
      params.onTurnReset();
    }
  };
  const buildProgressSummaryLine = () => {
    closePendingWindowThought();
    const seconds = Math.max(1, Math.round((Date.now() - progressTurnStartedAt) / 1000));
    const parts = [
      ...(progressReasoningSteps > 0
        ? [`🧠 ${progressReasoningSteps} thought${progressReasoningSteps === 1 ? "" : "s"}`]
        : []),
      ...(progressCommentaryNotes > 0
        ? [`💬 ${progressCommentaryNotes} note${progressCommentaryNotes === 1 ? "" : "s"}`]
        : []),
      ...(progressToolCalls > 0
        ? [`🛠️ ${progressToolCalls} tool call${progressToolCalls === 1 ? "" : "s"}`]
        : []),
      `⏱️ ${seconds}s`,
    ];
    return `-# ${parts.join(" · ")}`;
  };

  const replyOptions: Partial<ReplyOptions> = {
    onAssistantMessageStart: draftPreview.draftStream ? handleAssistantMessageBoundary : undefined,
    onReasoningEnd: draftPreview.draftStream
      ? () => {
          closePendingWindowThought();
          handleAssistantMessageBoundary();
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
    reasoningPayloadsEnabled: reasoningDurableEnabled,
    onVerboseProgressVisibility: (isActive) => {
      shouldYieldDraftProgress = isActive;
    },
    onNarrationUpdate: draftPreview.narrationProgressEnabled
      ? async (payload) => {
          if (isProcessAborted(abortSignal) || shouldYieldDraftProgress()) {
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
        return;
      }
      if (payload?.text) {
        windowReasoningOpen = true;
      }
      await params.reactions.controller.setThinking();
      await draftPreview.pushReasoningProgress(payload?.text, {
        snapshot: payload?.isReasoningSnapshot === true,
      });
    },
    streamReasoningInNonStreamModes: reasoningWindowEnabled,
    onToolStart: async (payload) => {
      if (isProcessAborted(abortSignal)) {
        return;
      }
      await params.reactions.maybeBindToToolReaction(payload);
      await params.reactions.controller.setTool(payload.name);
      if (payload.phase === "start") {
        closePendingWindowThought();
      }
      if (shouldYieldDraftProgress()) {
        return;
      }
      // Match the compositor: message/react/typing are not work-tool lines.
      if (payload.phase === "start" && isChannelProgressDraftWorkToolName(payload.name)) {
        progressToolCalls += 1;
      }
      await draftPreview.pushToolProgress(
        buildChannelProgressDraftLineForEntry(
          discordConfig,
          {
            event: "tool",
            itemId: payload.itemId,
            toolCallId: payload.toolCallId,
            name: payload.name,
            phase: payload.phase,
            args: payload.args,
          },
          payload.detailMode ? { detailMode: payload.detailMode } : undefined,
        ),
        { toolName: payload.name },
      );
    },
    onItemEvent: async (payload) => {
      if (isFailedProgress(payload)) {
        return false;
      }
      if (payload.kind === "preamble") {
        if (shouldYieldDraftProgress()) {
          return undefined;
        }
        return await draftPreview.pushPreambleItemEvent(payload, noteWindowCommentary);
      }
      if (shouldYieldDraftProgress()) {
        return undefined;
      }
      await draftPreview.pushToolProgress(
        buildChannelProgressDraftLineForEntry(discordConfig, {
          event: "item",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
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
    onPlanUpdate: async (payload) => {
      if (payload.phase === "update") {
        await draftPreview.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
        });
      }
    },
    onApprovalEvent: async (payload) => {
      if (payload.phase === "requested") {
        await draftPreview.pushToolProgress(
          buildChannelProgressDraftLine({
            event: "approval",
            phase: payload.phase,
            title: payload.title,
            command: payload.command,
            reason: payload.reason,
            message: payload.message,
          }),
        );
      }
    },
    onCommandOutput: async (payload) => {
      if (isFailedProgress(payload)) {
        return false;
      }
      if (payload.phase !== "end" || shouldYieldDraftProgress()) {
        return undefined;
      }
      await draftPreview.pushToolProgress(
        buildChannelProgressDraftLine({
          event: "command-output",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
          phase: payload.phase,
          title: payload.title,
          name: payload.name,
          status: payload.status,
          exitCode: payload.exitCode,
        }),
      );
      return undefined;
    },
    onPatchSummary: async (payload) => {
      if (payload.phase !== "end" || shouldYieldDraftProgress()) {
        return;
      }
      await draftPreview.pushToolProgress(
        buildChannelProgressDraftLine({
          event: "patch",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
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
    onCompactionStart: async () => {
      if (!isProcessAborted(abortSignal)) {
        await params.reactions.controller.setCompacting();
      }
    },
    onCompactionEnd: async () => {
      if (!isProcessAborted(abortSignal)) {
        params.reactions.controller.cancelPending();
        await params.reactions.controller.setThinking();
      }
    },
  };

  return {
    replyOptions,
    buildProgressSummaryLine,
  };
}
