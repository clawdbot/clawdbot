import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";

const ACCEPTED_CHAT_SEND_MAX_DISPATCH_ATTEMPTS = 3;

export type AcceptedChatSendFailureDisposition =
  | "client-retry"
  | "reconcile"
  | "retry"
  | "terminal";

/** Classify an accepted-send failure without relying on unstable error text. */
export function classifyAcceptedChatSendFailure(params: {
  error: unknown;
  phase: "pre-ack" | "post-ack";
  executionStarted?: boolean;
  sideEffectsObserved?: boolean;
}): AcceptedChatSendFailureDisposition {
  if (params.executionStarted || params.sideEffectsObserved) {
    return "reconcile";
  }
  if (!isSessionTranscriptProjectionUnavailableError(params.error)) {
    return "terminal";
  }
  return params.phase === "post-ack" ? "retry" : "client-retry";
}

/** Preserve same-ID recovery unless execution may already have produced side effects. */
export function shouldRetainAcceptedChatSendRetryIdentity(
  disposition: AcceptedChatSendFailureDisposition,
): boolean {
  return disposition !== "reconcile";
}

/** Wait for the exact failed projection before another accepted-send dispatch attempt. */
export async function waitForAcceptedChatSendRetry(
  scope: Omit<SessionTranscriptReadScope, "sessionId">,
  error: unknown,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!isSessionTranscriptProjectionUnavailableError(error)) {
    throw error;
  }
  await waitForSessionTranscriptProjection({ ...scope, sessionId: error.sessionId }, abortSignal);
}

/** Retry only typed, pre-execution accepted-send failures while Gateway custody remains active. */
export async function runAcceptedChatSendDispatch<T>(params: {
  operation: () => Promise<T>;
  waitForRetry: (error: unknown) => Promise<void>;
  classify: (error: unknown) => AcceptedChatSendFailureDisposition;
  maxAttempts?: number;
}): Promise<T> {
  const maxAttempts = params.maxAttempts ?? ACCEPTED_CHAT_SEND_MAX_DISPATCH_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await params.operation();
    } catch (error) {
      if (attempt >= maxAttempts || params.classify(error) !== "retry") {
        throw error;
      }
      await params.waitForRetry(error);
    }
  }
}
