import type { ClientVoiceSessionRecord } from "./client-voice-session-store.js";
import "./client-voice-session.js";

type ClientVoiceSessionTestApi = {
  readRecord(agentId: string, voiceSessionId: string): ClientVoiceSessionRecord | undefined;
  reset(): void;
};

function getTestApi(): ClientVoiceSessionTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceSessionTestApi")
  ] as ClientVoiceSessionTestApi;
}

export const clientVoiceSessionTesting = {
  readRecord(agentId: string, voiceSessionId: string): ClientVoiceSessionRecord | undefined {
    return getTestApi().readRecord(agentId, voiceSessionId);
  },
  reset(): void {
    getTestApi().reset();
  },
};
