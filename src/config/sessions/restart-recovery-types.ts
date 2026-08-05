import type { TerminalDeliveryEvidenceResult } from "../../agents/terminal-delivery-evidence.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/source-reply-delivery-mode.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export type RestartRecoveryBeforeAgentReplyState =
  | "admitted"
  | "pending"
  | "continue"
  | "handled-silent"
  | "handled-reply"
  | "handled-unrecoverable";

export type RestartRecoveryTerminalDeliveryEvidenceResult = Omit<
  TerminalDeliveryEvidenceResult,
  "unsafeSideEffectsDetected"
> & {
  /** The terminal run reported a committed effect that makes fresh replay unsafe. */
  restartUnsafeSideEffectsDetected?: true;
};

export type RestartRecoveryTerminalDeliveryEvidence =
  RestartRecoveryTerminalDeliveryEvidenceResult & { runId: string };

/** Durable ownership and idempotency state for gateway restart recovery. */
export type SessionRestartRecoveryState = {
  restartRecoveryBeforeAgentReplyState?: RestartRecoveryBeforeAgentReplyState;
  /** Durable pre/post boundary around the terminal external send. */
  restartRecoveryDeliveryReceiptState?: "terminal-pending" | "delivered-terminal";
  /** Exact agent tool call whose terminal external send owns the receipt. */
  restartRecoveryDeliveryToolCallId?: string;
  restartRecoveryDeliveryContext?: DeliveryContext;
  /** Exact host-owned media allowlist for a generated-media recovery run. */
  restartRecoveryDeliveryMediaUrls?: string[];
  /** Keeps the message tool absent while a generated-media recovery run is resumed. */
  restartRecoveryDisableMessageTool?: true;
  /** Suppresses visible text when a recovery attempt repairs only missing media. */
  restartRecoverySuppressTextDelivery?: true;
  restartRecoveryDeliveryRequestFingerprint?: string;
  restartRecoveryDeliveryRunId?: string;
  restartRecoveryDeliverySourceRunId?: string;
  restartRecoveryRequesterAccountId?: string;
  restartRecoveryRequesterSenderId?: string;
  restartRecoverySameChannelThreadRequired?: true;
  restartRecoverySourceIngress?: "channel" | "control-ui" | "internal";
  restartRecoverySourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  restartRecoveryTerminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidence[];
  restartRecoveryTerminalRunIds?: string[];
};
