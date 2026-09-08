// Discord plugin module implements agent control behavior.
import {
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveDiscordVoiceAgentRunTarget } from "./agent-run-target.js";
import type { VoiceSessionEntry } from "./session.js";

type DiscordVoiceAgentControlEntry = Pick<
  VoiceSessionEntry,
  "route" | "generation" | "sessionLifecycle"
>;

type DiscordVoiceAgentControlOutcome =
  | {
      handled: true;
      result: RealtimeVoiceAgentControlResult;
      speakText?: string;
    }
  | {
      handled: false;
      result?: RealtimeVoiceAgentControlResult;
    };

/** Always pass owned runTarget or null — never omit into session-key legacy. */
export async function controlDiscordVoiceAgentRun(params: {
  entry: DiscordVoiceAgentControlEntry;
  text: string;
  mode?: unknown;
}): Promise<RealtimeVoiceAgentControlResult> {
  return controlRealtimeVoiceAgentRun({
    sessionKey: params.entry.route.sessionKey,
    runTarget: resolveDiscordVoiceAgentRunTarget(params.entry),
    text: params.text,
    ...(params.mode === undefined ? {} : { mode: params.mode }),
  });
}

export async function maybeControlDiscordVoiceAgentRun(params: {
  entry: DiscordVoiceAgentControlEntry;
  text: string;
}): Promise<DiscordVoiceAgentControlOutcome> {
  if (!shouldAutoControlRealtimeVoiceAgentText(params.text)) {
    return { handled: false };
  }
  const result = await controlDiscordVoiceAgentRun(params);

  if (!result.active) {
    return { handled: false, result };
  }

  return {
    handled: true,
    result,
    ...(result.speak && !result.suppress ? { speakText: result.message } : {}),
  };
}
