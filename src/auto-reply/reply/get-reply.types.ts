import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionEntry, SessionToolOverrides } from "../../config/sessions/types.js";
// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";
import type { FollowupQueueDisposition, QueuedFollowupReplyBatch } from "./queue/types.js";
import type { ReplyOptionsWithAdmissionTicket } from "./reply-admission-ticket.js";
import type { ReplyOptionsWithOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  lifecycleRevision?: string;
  storePath?: string;
};

export type PendingContinuationSettlement = {
  settle: (statusDelivered: boolean) => Promise<void>;
};

export type ReplyRunVerbosity = {
  verboseLevelOverride?: VerboseLevel;
  resolvedVerboseLevel: VerboseLevel;
};

type InternalReplySessionOptions = {
  /** Invocation-owned conversation facts; never execution or sender authority. */
  replyConversation?: PreparedReplyConversation;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  /** Exact authority-bearing settings captured by Gateway chat admission. */
  admittedSessionSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  /** Host-stamped exact-run capability for late Codex creator-authority capture. */
  cronCreatorAuthorityCapability?: CronCreatorAuthorityCapability;
  expectedExistingSessionId?: string;
  /** First dispatch only: admission created this exact pinned session before reply initialization. */
  newlyCreatedSessionId?: string;
  onDeliberateSilentTerminalReply?: () => void;
  /** Defers the child-completion wake until the visible waiting status is delivered. */
  onPendingContinuation?: (settlement?: PendingContinuationSettlement) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  /** Publishes each executing turn's preferences without persisting them to its session. */
  onRunVerbosityResolved?: (settings: ReplyRunVerbosity) => void;
  /** Prevent implicit rollover after a caller has durably admitted this exact session. */
  pinExpectedExistingSession?: boolean;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
  /** Receives terminal queue-cap outcomes without widening the public reply API. */
  onFollowupQueueDisposition?: (disposition: FollowupQueueDisposition) => void;
  /** Delivers queued replies only through their originating Gateway admission. */
  onQueuedFollowupReplyBatch?: (batch: QueuedFollowupReplyBatch) => Promise<void> | void;
  /** Overrides persisted queue mode for this reply only. */
  queueModeOverride?: QueueMode;
  /** Dispatch-owned operation used to defer hooks until durable run admission. */
  replyOperation?: ReplyOperation;
  skillOverrides?: SessionToolOverrides["skills"];
  /** Gateway-private optimistic-concurrency constraint for an operator-requested proposal revision. */
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
};

export type InternalGetReplyOptions = GetReplyOptions &
  PluginCommandReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithOperationRunState &
  ReplyOptionsWithAdmissionTicket;

export function shouldBridgeCliPreambleEvents(opts: InternalGetReplyOptions | undefined): boolean {
  return opts?.commentaryProgressEnabled === true || opts?.progressPreambleEnabled === true;
}

/** Reply resolver signature used by dispatchers and tests for dependency injection. */
export type GetReplyFromConfig = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

export type InternalGetReplyFromConfig = (
  ctx: MsgContext,
  opts?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
