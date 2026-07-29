// Message lifecycle logging helpers emit queue and processing diagnostic events.
import { logMessageProcessed, logMessageQueued, logSessionStateChange } from "./diagnostic.js";

type MessageLifecycleRef = {
  sessionId?: string;
  sessionKey?: string;
};

type MessageLifecycleOutcome = "completed" | "skipped" | "error";

type MessageLifecycleProcessedOptions = MessageLifecycleRef & {
  durationMs?: number;
  reason?: string;
  error?: string;
};

export function createDiagnosticMessageLifecycle(
  params: MessageLifecycleRef & {
    enabled: boolean;
    channel: string;
    source: string;
    chatId?: number | string;
    messageId?: number | string;
    processingReason?: string;
    startedAtMs?: number;
    trackSessionState: boolean;
  },
) {
  const startedAtMs = params.startedAtMs ?? Date.now();
  const resolveRef = (override?: MessageLifecycleRef): MessageLifecycleRef => ({
    sessionId: override?.sessionId ?? params.sessionId,
    sessionKey: override?.sessionKey ?? params.sessionKey,
  });
  const hasSessionRef = (ref: MessageLifecycleRef): boolean =>
    Boolean(ref.sessionId || ref.sessionKey);

  // Processed events still matter without a session ref; queue-depth/state events do not.
  const canTrackSessionState = (ref: MessageLifecycleRef): boolean =>
    params.enabled && params.trackSessionState && hasSessionRef(ref);

  return {
    markProcessing(override?: MessageLifecycleRef): void {
      const ref = resolveRef(override);
      if (!canTrackSessionState(ref)) {
        return;
      }
      logMessageQueued({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        channel: params.channel,
        source: params.source,
      });
      logSessionStateChange({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        state: "processing",
        reason: params.processingReason,
      });
    },

    markIdle(reason?: string, override?: MessageLifecycleRef): void {
      const ref = resolveRef(override);
      if (!canTrackSessionState(ref)) {
        return;
      }
      logSessionStateChange({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        state: "idle",
        reason,
      });
    },

    markProcessed(
      outcome: MessageLifecycleOutcome,
      options?: MessageLifecycleProcessedOptions,
    ): void {
      if (!params.enabled) {
        return;
      }
      const ref = resolveRef(options);
      logMessageProcessed({
        channel: params.channel,
        chatId: params.chatId,
        messageId: params.messageId,
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        durationMs: options?.durationMs ?? Date.now() - startedAtMs,
        outcome,
        reason: options?.reason,
        error: options?.error,
      });
    },
  };
}
