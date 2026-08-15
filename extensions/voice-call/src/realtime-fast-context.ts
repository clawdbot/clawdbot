// Voice Call plugin module implements realtime fast context behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveRealtimeVoiceFastContextConsult,
  type RealtimeVoiceFastContextConsultResult,
  type RealtimeVoiceFastContextConfig,
} from "openclaw/plugin-sdk/realtime-voice";

type Logger = {
  debug?: (message: string) => void;
};

// Voice-call labels for the SDK realtime fast-context resolver.

/** Resolve fast-context consult data using caller-oriented labels. */
export async function resolveRealtimeFastContextConsult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  args: unknown;
  logger: Logger;
}): Promise<RealtimeVoiceFastContextConsultResult> {
  return await resolveRealtimeVoiceFastContextConsult({
    ...params,
    labels: {
      audienceLabel: "caller",
      contextName: "OpenClaw memory or session context",
    },
  });
}
