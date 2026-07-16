// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOptionsWithHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { QueueMode } from "./queue/types.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
};

type InternalReplySessionOptions = {
  expectedExistingSessionId?: string;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  /** Prevent implicit rollover after a caller has durably admitted this exact session. */
  pinExpectedExistingSession?: boolean;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
  /** Marks when this reply is waiting to own its session's reply lane. */
  onReplyAdmissionWaitChange?: (waiting: boolean) => void;
  /** Overrides persisted queue mode for this reply only. */
  queueModeOverride?: QueueMode;
};

export type InternalGetReplyOptions = GetReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithHeartbeatRunScope;

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
