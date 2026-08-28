import type { MeetingBrowserHealth } from "./session-types.js";

export function isMeetingTalkBackMode(mode: string): boolean {
  return mode === "agent" || mode === "bidi";
}

export function isMeetingRealtimeRouteReady(
  mode: string,
  health:
    | (MeetingBrowserHealth & {
        audioInputRouted?: boolean;
        audioOutputRouted?: boolean;
      })
    | undefined,
): boolean {
  return (
    isMeetingTalkBackMode(mode) &&
    health?.inCall === true &&
    health.micMuted === false &&
    health.audioInputRouted === true &&
    health.audioOutputRouted === true &&
    health.manualAction === undefined
  );
}
