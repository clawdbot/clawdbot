// Discord plugin module implements agent control behavior.
import {
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceSessionEntry } from "./session.js";

export type DiscordVoiceAgentControlOutcome =
  | {
      handled: true;
      result: RealtimeVoiceAgentControlResult;
      speakText?: string;
    }
  | {
      handled: false;
      result?: RealtimeVoiceAgentControlResult;
    };

export async function maybeControlDiscordVoiceAgentRun(params: {
  entry: Pick<VoiceSessionEntry, "route">;
  text: string;
}): Promise<DiscordVoiceAgentControlOutcome> {
  if (!shouldAutoControlRealtimeVoiceAgentText(params.text)) {
    return { handled: false };
  }
  const result = await controlRealtimeVoiceAgentRun({
    sessionKey: params.entry.route.sessionKey,
    text: params.text,
  });

  if (!result.active) {
    return { handled: false, result };
  }

  return {
    handled: true,
    result,
    ...(result.speak && !result.suppress ? { speakText: result.message } : {}),
  };
}
