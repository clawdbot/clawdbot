import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import "./client-voice-session.js";

type ClientVoiceSessionTestApi = {
  readRecord(agentId: string, voiceSessionId: string): ClientVoiceSessionRecord | undefined;
  digestDeliveryPolicy: {
    maxRetainedIntents: number;
    maxRetainedIdentityBytes: number;
    maxConcurrentAttempts: number;
    maxAttemptFailures: number;
    attemptAbortAfterMs: number;
    failureRetentionMs: number;
  };
  digestDeliverySnapshot(): {
    active: number;
    pending: number;
    retained: number;
    retainedIdentityBytes: number;
  };
  reset(): void;
};

function getTestApi(): ClientVoiceSessionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceSessionTestApi")
  ] as ClientVoiceSessionTestApi;
}

export const clientVoiceSessionTesting = {
  digestDeliveryPolicy: getTestApi().digestDeliveryPolicy,
  digestDeliverySnapshot(): ReturnType<ClientVoiceSessionTestApi["digestDeliverySnapshot"]> {
    return getTestApi().digestDeliverySnapshot();
  },
  readRecord(agentId: string, voiceSessionId: string): ClientVoiceSessionRecord | undefined {
    return getTestApi().readRecord(agentId, voiceSessionId);
  },
  reset(): void {
    getTestApi().reset();
  },
};
