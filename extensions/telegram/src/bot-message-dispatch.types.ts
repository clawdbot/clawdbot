import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type {
  AgentPlanStep,
  ChannelProgressDraftLine,
  TextChunkMode,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.types.js";
import type { TelegramNativeQuoteCandidateByMessageId } from "./bot/native-quote.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type {
  DraftLaneState,
  LaneDeliveryStateTracker,
  LaneName,
  LaneTextDeliverer,
} from "./lane-delivery.js";

export type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "mediaMaxMb" | "ownerAgentId">;
  retryDispatchErrors?: boolean;
  suppressFailureFallback?: boolean;
  /**
   * Canonical turn ownership lifecycle from the durable ingress drain
   * (or a test double). Pre-adoption abort + adopt/defer/abandon.
   */
  turnAdoptionLifecycle?: {
    admission?: "exclusive" | "cancel-only";
    onAdopted: () => void | Promise<void>;
    onDeferred?: () => void;
    onAbandoned?: () => void;
    abortSignal?: AbortSignal;
  };
};

export type TelegramDispatchResult =
  | { kind: "completed" }
  | { kind: "failed-retryable"; error: unknown };

export type TelegramReasoningLevel = "off" | "on" | "stream";
export type TelegramTranscriptMirrorPayload = { text?: string; mediaUrls?: string[] };
export type CurrentTurnTranscriptFinal = { messageId?: string; text: string };
export type TelegramScopedTranscriptSession = { sessionId: string; storePath: string };

export type FreshTelegramSessionEntryLoader = ((
  agentId: string,
  sessionKey: string,
) => {
  storePath: string;
  entry?: SessionEntry;
}) & {
  clear: () => void;
};

export type TelegramAnswerBlockDelivery = {
  payload: ReplyPayload;
  text: string;
  buttons: import("./button-types.js").TelegramInlineButtons | undefined;
};

export type TelegramDispatchTurnConfig = Omit<
  DispatchTelegramMessageParams,
  "context" | "telegramDeps"
> & {
  allowProviderPreview: boolean;
  chunkMode: TextChunkMode;
  context: TelegramMessageContext;
  dispatchStartedAt: number;
  draftReplyToMessageId?: number;
  isSuperseded: () => boolean;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  mediaLocalRoots: readonly string[];
  replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId;
  replyQuoteEntities?: Message["entities"];
  replyQuoteMessageId?: number;
  replyQuotePosition?: number;
  replyQuoteText?: string;
  resolvedReasoningLevel: TelegramReasoningLevel;
  statusReactionController: TelegramMessageContext["statusReactionController"];
  tableMode: Parameters<
    NonNullable<import("./bot-deps.js").TelegramBotDeps["deliverReplies"]>
  >[0]["tableMode"];
  telegramDeps: import("./bot-deps.js").TelegramBotDeps;
};

export type TelegramDraftPartialTextUpdate = {
  text: string;
  delta?: string;
  replace?: true;
  isReasoningSnapshot?: boolean;
};
export type TelegramSplitLaneSegmentsResult = {
  segments: Array<{ lane: LaneName; update: TelegramDraftPartialTextUpdate }>;
  suppressedReasoningOnly: boolean;
};
export type TelegramQueuedAnswerBlockRotation = {
  assistantMessageIndex?: number;
  text?: string;
  shouldRotateBeforeDelivery: boolean;
};
export type TelegramBufferedFinalSettlement = {
  visibleReplySent: boolean;
  onPlatformSendDispatch?: () => Promise<void>;
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  resolve: (result: { visibleReplySent: boolean }) => void;
  reject: (error: unknown) => void;
};

type BufferedDispatchParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type ReplyOptions = NonNullable<BufferedDispatchParams["replyOptions"]>;
type CallbackPayload<K extends keyof ReplyOptions> =
  NonNullable<ReplyOptions[K]> extends (...args: infer Args) => unknown ? Args[0] : never;

export type TelegramProgressSummaryCounters = {
  reasoningSteps: number;
  commentaryNotes: number;
  toolCalls: number;
};

export type TelegramProgressSummaryTracker = {
  noteReasoningActivity: () => void;
  closeReasoningBurst: () => void;
  noteToolCall: () => void;
  noteCommentary: (itemId?: string, text?: string) => void;
  closeCommentaryBurst: () => void;
  counts: () => TelegramProgressSummaryCounters;
  hasActivity: () => boolean;
};

type TelegramProgressCompositor = {
  readonly commentaryProgressEnabled: boolean;
  readonly hasStatusHeadline: boolean;
  readonly hasPlanProgress: boolean;
  markFinalReplyStarted: () => void;
  markFinalReplyDelivered: () => void;
  beginNewTurn: (options?: { force?: boolean }) => boolean;
  reset: () => void;
  suppress: () => void;
  cancel: () => void;
  pushToolProgress: (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => Promise<boolean>;
  pushReasoningProgress: (text?: string, options?: { snapshot?: boolean }) => Promise<boolean>;
  pushCommentaryProgress: (text?: string, options?: { itemId?: string }) => Promise<boolean>;
  pushPlanProgress: (
    steps?: AgentPlanStep[],
    options?: { explanation?: string },
  ) => Promise<boolean>;
  pushPreambleHeadline: (text?: string, options?: { itemId?: string }) => Promise<boolean>;
  pushToolEvent: (payload: CallbackPayload<"onToolStart">) => Promise<boolean>;
  pushItemEvent: (payload: CallbackPayload<"onItemEvent">) => Promise<boolean>;
  pushApprovalEvent: (payload: CallbackPayload<"onApprovalEvent">) => Promise<boolean>;
  pushCommandOutputEvent: (payload: CallbackPayload<"onCommandOutput">) => Promise<boolean>;
  pushPatchEvent: (payload: CallbackPayload<"onPatchSummary">) => Promise<boolean>;
};

export type TelegramBufferedFinalAnswer = {
  payload: ReplyPayload;
  text: string;
};

export type TelegramReasoningStepState = {
  noteReasoningHint: () => void;
  noteReasoningDelivered: () => void;
  shouldBufferFinalAnswer: () => boolean;
  bufferFinalAnswer: (value: TelegramBufferedFinalAnswer) => void;
  takeBufferedFinalAnswer: () => TelegramBufferedFinalAnswer | undefined;
  resetForNextStep: () => void;
};

export type TelegramDraftStateSlice = {
  answerLane: DraftLaneState;
  reasoningLane: DraftLaneState;
  lanes: Record<LaneName, DraftLaneState>;
  streamDeliveryEnabled: boolean;
  streamReasoningInProgressDraft: boolean;
  disableBlockStreaming: boolean | undefined;
  durableReasoningPayloadsEnabled: boolean;
  lastAnswerPartialText: string;
  activeAnswerDraftIsToolProgressOnly: boolean;
  activeAnswerBlockAssistantMessageIndex: number | undefined;
  activeAnswerBlockDelivery: TelegramAnswerBlockDelivery | undefined;
  queuedAnswerBlockRotations: TelegramQueuedAnswerBlockRotation[];
  queuedAnswerBlockAssistantMessageIndex: number | undefined;
  pendingAnswerBlockAssistantMessageIndex: number | undefined;
  rotateAnswerLaneWhenQueuedBlocksSettle: boolean;
  draftEventQueue: Promise<void>;
};

export type TelegramProgressStateSlice = {
  progressSummary: TelegramProgressSummaryTracker;
  progressSummaryStartedAt: number;
  summaryDelivered: boolean;
  draftEverRendered: boolean;
  finalAnswerDeliveryStarted: boolean;
  finalAnswerDelivered: boolean;
  sawProgressFinal: boolean;
  verboseProgressActive: () => boolean;
  progressCompositor: TelegramProgressCompositor;
  commentaryProgressEnabled: boolean;
  progressPreambleEnabled: boolean | undefined;
};

export type TelegramDeliveryStateSlice = {
  deliveryState: LaneDeliveryStateTracker;
  deliverLaneText: LaneTextDeliverer;
  materializeAnswerLaneBeforeRotation: () => Promise<void>;
  resolveCurrentTurnTranscriptFinal: () => Promise<CurrentTurnTranscriptFinal | undefined>;
  transcriptMirrorSequence: number;
  transcriptMirrorTurnId: string;
  implicitQuoteReplyTargetId: string | undefined;
  currentMessageIdForQuoteReply: string | undefined;
};

export type TelegramReplyStateSlice = {
  reasoningStepState: TelegramReasoningStepState;
  bufferedFinalSettlement: TelegramBufferedFinalSettlement | undefined;
  sentBlockMediaUrls: Set<string>;
  splitReasoningOnNextStream: boolean;
};

export type TelegramDispatchTurn = TelegramDispatchTurnConfig &
  TelegramDraftStateSlice &
  TelegramProgressStateSlice &
  TelegramDeliveryStateSlice &
  TelegramReplyStateSlice & {
    queuedFinal: boolean;
    agentRunFailed?: boolean;
    noVisibleReplyFallbackEligible: boolean;
    suppressSilentReplyFallback: boolean;
    hadErrorReplyFailureOrSkip: boolean;
    dispatchError?: unknown;
  };
