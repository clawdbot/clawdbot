import {
  createOrResumeClientVoiceSession as createPinnedVoiceSession,
  registerClientVoiceConsultRun as registerPinnedVoiceRun,
} from "./client-voice-session.js";

type VoiceSessionCreateParams = Omit<
  Parameters<typeof createPinnedVoiceSession>[0],
  "agentSessionKey"
> & { agentSessionKey?: string };

export function createOrResumeClientVoiceSession(params: VoiceSessionCreateParams): string {
  return createPinnedVoiceSession({
    ...params,
    agentSessionKey: params.agentSessionKey ?? params.sessionKey,
  });
}

type VoiceRunParams = Omit<Parameters<typeof registerPinnedVoiceRun>[0], "agentSessionKey"> & {
  agentSessionKey?: string;
};

export function registerClientVoiceConsultRun(params: VoiceRunParams): void {
  registerPinnedVoiceRun({
    ...params,
    agentSessionKey: params.agentSessionKey ?? params.sessionKey,
  });
}
