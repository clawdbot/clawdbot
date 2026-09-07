import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";

type RelayAgentConsultRunner = RealtimeVoiceAgentConsultRunner & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export function bindTalkRealtimeRelayAgentConsult(
  runPrompt: RelayAgentConsultRunner,
  isCurrent: () => boolean,
) {
  const runAgentConsult: RealtimeVoiceAgentConsultRunner = async (request) => {
    if (!isCurrent()) {
      throw new Error("Realtime gateway-relay session is closed");
    }
    return await runPrompt(request);
  };
  const steer = runPrompt.steer;
  const lifecycleMethods = {
    adoptCompletionClaims: () => runPrompt.adoptCompletionClaims(),
    claimAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimAppend();
      return current && claimed;
    },
    claimFailureAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimFailureAppend();
      return current && claimed;
    },
    ...(steer
      ? {
          steer: async (request: Parameters<RealtimeVoiceAgentConsultRunner>[0]) => {
            if (!isCurrent()) {
              throw new Error("Realtime relay session is no longer active");
            }
            return await steer(request);
          },
        }
      : {}),
  };
  return Object.assign(runAgentConsult, lifecycleMethods);
}
