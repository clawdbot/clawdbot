import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { FollowupQueueDisposition, QueuedFollowupReplyBatch } from "./queue/types.js";
import type { ReplyOptionsWithAdmissionTicket } from "./reply-admission-ticket.js";
import type { ReplyOptionsWithOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
};

type InternalReplySessionOptions = {
  /** Host-stamped exact-run capability for late Codex creator-authority capture. */
  cronCreatorAuthorityCapability?: CronCreatorAuthorityCapability;
  expectedExistingSessionId?: string;
  /** First dispatch only: admission created this exact pinned session before reply initialization. */
  newlyCreatedSessionId?: string;
  onDeliberateSilentTerminalReply?: () => void;
  onPendingContinuation?: () => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
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
