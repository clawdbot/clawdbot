/**
 * Durable outbound message recovery state.
 *
 * Creates and classifies persisted send records after delivery interruptions.
 */
import type { DurableMessageSendIntent, MessageReceipt } from "./types.js";

/** Durable send state stored for recovery and operator-visible delivery status. */
export type DurableMessageSendState =
  | "pending"
  | "sent"
  | "suppressed"
  | "failed"
  | "unknown_after_send";

/** Recovery record for one durable outbound message intent. */
export type DurableMessageStateRecord = {
  intent: DurableMessageSendIntent;
  state: DurableMessageSendState;
  receipt?: MessageReceipt;
  updatedAt: number;
  errorMessage?: string;
};

/** Creates a durable message recovery record from intent, receipt, and optional error state. */
export function createDurableMessageStateRecord(params: {
  intent: DurableMessageSendIntent;
  state?: DurableMessageSendState;
  receipt?: MessageReceipt;
  updatedAt?: number;
  error?: unknown;
}): DurableMessageStateRecord {
  return {
    intent: params.intent,
    state: params.state ?? (params.receipt ? "sent" : "pending"),
    ...(params.receipt ? { receipt: params.receipt } : {}),
    updatedAt: params.updatedAt ?? Date.now(),
    ...(params.error === undefined ? {} : { errorMessage: normalizeErrorMessage(params.error) }),
  };
}

/** Classifies recovery state from persisted intent/receipt facts after a send interruption. */
export function classifyDurableSendRecoveryState(params: {
  hasIntent: boolean;
  hasReceipt: boolean;
  platformSendMayHaveStarted: boolean;
  failed?: boolean;
  suppressed?: boolean;
}): DurableMessageSendState {
  if (params.failed) {
    return "failed";
  }
  if (params.suppressed) {
    return "suppressed";
  }
  if (params.hasReceipt) {
    return "sent";
  }
  if (params.hasIntent && params.platformSendMayHaveStarted) {
    return "unknown_after_send";
  }
  return "pending";
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
