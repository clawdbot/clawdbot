// Discord-local owned runTarget for active-run voice control.
import {
  resolveOwnedActiveRealtimeVoiceRunTargetForAgent,
  type RealtimeVoiceAgentRunTarget,
} from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceSessionEntry } from "./session.js";

export type DiscordVoiceAgentRunTarget = RealtimeVoiceAgentRunTarget | null;

/** Exact owned run for this voice session route, or null (fail-closed). */
export function resolveDiscordVoiceAgentRunTarget(
  entry: Pick<VoiceSessionEntry, "route" | "generation" | "sessionLifecycle">,
): DiscordVoiceAgentRunTarget {
  const generation = entry.generation;
  return resolveOwnedActiveRealtimeVoiceRunTargetForAgent({
    sessionKey: entry.route.sessionKey,
    agentId: entry.route.agentId,
    isSessionCurrent: () =>
      entry.generation === generation && entry.sessionLifecycle.status === "active",
  });
}
