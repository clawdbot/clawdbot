import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyContinuationController } from "./agent-runner-continuation.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import type { SettledAgentTurn } from "./agent-runner-execution.types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { NoOpRearmWakeClass } from "./no-op-rearm-guard.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { resolveReplyToMode } from "./reply-threading.js";
import type { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import type { TypingSignaler } from "./typing-mode.js";

export type FinalizeReplyAgentRunInput = Pick<
  RunReplyAgentParams,
  | "blockStreamingEnabled"
  | "commandBody"
  | "defaultModel"
  | "followupRun"
  | "opts"
  | "queueKey"
  | "replyThreadingOverride"
  | "resolvedBlockStreamingBreak"
  | "resolvedQueue"
  | "resolvedVerboseLevel"
  | "runtimePolicySessionKey"
  | "sessionCtx"
  | "sessionKey"
  | "shouldInjectGroupIntro"
  | "storePath"
> & {
  activeIsNewSession: boolean;
  activeSessionEntry: SessionEntry | undefined;
  activeSessionStore: Record<string, SessionEntry> | undefined;
  blockReplyPipeline: BlockReplyPipeline | null;
  cfg: OpenClawConfig;
  continuation: ReplyContinuationController;
  getActiveSessionEntry: () => SessionEntry | undefined;
  isHeartbeat: boolean;
  noOpRearmWakeClass: NoOpRearmWakeClass | undefined;
  pendingToolTasks: Set<Promise<void>>;
  preflightCompactionApplied: boolean | undefined;
  replyMediaContext: ReplyMediaContext;
  replyOperation: ReplyOperation;
  replyRouteThreadId: ReturnType<typeof resolveRoutedDeliveryThreadId>;
  replySessionKey: string | undefined;
  replyToChannel: OriginatingChannelType | undefined;
  replyToMode: ReturnType<typeof resolveReplyToMode>;
  returnWithQueuedFollowupDrain: <T>(value: T) => T;
  runFollowupTurn: (queued: FollowupRun) => Promise<void>;
  execution: SettledAgentTurn;
  runId: string;
  runStartedAt: number;
  setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
  typingSignals: TypingSignaler;
};
