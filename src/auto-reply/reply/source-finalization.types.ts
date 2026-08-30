import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

/** Exact source-owned delivery and presentation state retained by an admitted queued turn. */
export type QueuedSourceReplyDelivery = {
  deliver: (
    payload: ReplyPayload,
    info: { kind: ReplyDispatchKind; runId: string },
  ) => Promise<ReplyDispatchDeliveryOutcome>;
  presentationOptions: QueuedSourceReplyPresentationOptions;
};

/** Turn-local final-candidate gate owned by one admitted source event. */
export type TurnLocalBeforeAgentFinalize = (event: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  lastAssistantMessage: string;
  revisionAttempt: number;
}) =>
  | Promise<
      | { action: "continue" }
      | {
          action: "revise";
          instruction: string;
          /** Hidden revision attempts must never repeat tool side effects. */
          disableTools: true;
          /** Source-local cleanup accepted before the hidden retry can emit progress. */
          onAccepted?: () => Promise<void> | void;
        }
      | {
          /** Suppress this candidate deterministically without another model call. */
          action: "discard";
          onAccepted?: () => Promise<void> | void;
        }
    >
  | { action: "continue" }
  | {
      action: "revise";
      instruction: string;
      disableTools: true;
      onAccepted?: () => Promise<void> | void;
    }
  | {
      action: "discard";
      onAccepted?: () => Promise<void> | void;
    };

/** Private source-finalization policy carried only until core admits the turn. */
export type SourceFinalizationPrivateOptions = {
  onBeforeAgentFinalize?: TurnLocalBeforeAgentFinalize;
  /** Revalidates the exact source owner at every retained callback/delivery boundary. */
  isSourceLive?: () => boolean;
  deferSourceMessageToolDelivery: true;
  retainQueuedSourceReplyDelivery: true;
};

/**
 * Source-local queued execution/presentation state that must not drift to a
 * later runner owner. Capture every key explicitly, including `undefined`, so
 * an older turn clears callbacks installed by a newer source.
 */
export type QueuedSourceReplyPresentationOptions = Pick<
  GetReplyOptions,
  | "promptCacheKey"
  | "onAgentRunStart"
  | "isHeartbeat"
  | "bootstrapContextMode"
  | "suppressToolErrorWarnings"
  | "enableHeartbeatTool"
  | "forceHeartbeatTool"
  | "suppressDefaultToolProgressMessages"
  | "suppressToolProgressMessages"
  | "allowToolLifecycleWhenProgressHidden"
  | "allowProgressCallbacksWhenSourceDeliverySuppressed"
  | "onVerboseProgressVisibility"
  | "preserveProgressCallbackStartOrder"
  | "onPartialReply"
  | "onReasoningStream"
  | "onReasoningProgress"
  | "streamReasoningInNonStreamModes"
  | "onReasoningEnd"
  | "onAssistantMessageStart"
  | "onBlockReplyQueued"
  | "onBlockReply"
  | "onToolResult"
  | "onToolStart"
  | "onItemEvent"
  | "onNarrationUpdate"
  | "onProgressNarratorLifecycle"
  | "isProgressDraftVisible"
  | "narrationHideCommandText"
  | "commentaryProgressEnabled"
  | "progressPreambleEnabled"
  | "reasoningPayloadsEnabled"
  | "commentaryPayloadsEnabled"
  | "shouldDeliverCommentaryPayloads"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"
  | "onCompactionStart"
  | "onCompactionEnd"
  | "onModelSelected"
  | "onQueuedFollowupAdmitted"
  | "onQueuedFollowupSettled"
  | "onObservedReplyDelivery"
  | "forceToolResultProgress"
  | "hasRepliedRef"
> & {
  /** Internal presentation observers are also source-owned. */
  onDeliberateSilentTerminalReply?: (() => void) | undefined;
  onPendingContinuation?: (() => void) | undefined;
  /** Never inherit a newer run's exact-run authority into an older queued turn. */
  cronCreatorAuthorityCapability?: undefined;
};
