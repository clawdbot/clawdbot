import type {
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetModeInput,
  GoogleMeetTransport,
} from "./config.js";
import type { GoogleMeetSession } from "./transports/types.js";

export function resolveTransport(
  input: GoogleMeetTransport | undefined,
  config: GoogleMeetConfig,
): GoogleMeetTransport {
  return input ?? config.defaultTransport;
}

export function resolveMode(
  input: GoogleMeetModeInput | undefined,
  config: GoogleMeetConfig,
): GoogleMeetMode {
  return input === "realtime" ? "agent" : (input ?? config.defaultMode);
}

export function withSessionAgentConfig(
  config: GoogleMeetConfig,
  agentId: string,
): GoogleMeetConfig {
  return config.realtime.agentId === agentId
    ? config
    : { ...config, realtime: { ...config.realtime, agentId } };
}

export function isBrowserTransport(transport: GoogleMeetTransport): boolean {
  return transport === "chrome" || transport === "chrome-node";
}

export function noteSession(session: GoogleMeetSession, note: string): void {
  session.notes = [...session.notes.filter((item) => item !== note), note];
}

export const GOOGLE_MEET_SESSION_MESSAGES = {
  previousBrowserLeaveFailed: "Could not leave the previous Meet browser tab before reassignment.",
  reassignedSessionNote: "Ended before the same Meet tab was reassigned to another agent.",
  reusedSessionNote: "Reused existing active Meet session.",
  replacementBrowserLeaveFailed:
    "Could not leave the previous Meet browser tab before reassignment.",
  speechBlockedFallback: "Realtime speech blocked until Google Meet is ready.",
  speech: {
    audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
    browserUnverified: "Google Meet browser state has not been verified yet.",
    manualActionFallback: "Resolve the Google Meet browser prompt before asking OpenClaw to speak.",
    microphoneMuted: "Turn on the OpenClaw Google Meet microphone before asking OpenClaw to speak.",
    microphoneMutedReason: "meet-microphone-muted",
    notInCall: "Google Meet has not reported that the browser participant is in the call.",
    notInCallReason: "not-in-call",
    browserUnverifiedReason: "browser-unverified",
    audioBridgeUnavailableReason: "audio-bridge-unavailable",
  },
} as const;

export type GoogleMeetTrackedRecoveryScope = {
  mode?: GoogleMeetMode;
  trackedMeetingUrl?: string;
  trackedTargetId?: string;
  url: string;
};

// Ownership signal for untargeted recover_current_tab: the most recent active
// session on the transport, else the latest tab createViaBrowser opened
// (node-only, by meeting URL). trackedMeetingUrl + url must match or the
// browser-controller guard treats the tracked target as another meeting and
// ignores it.
export function trackedRecoveryScope(params: {
  sessions: GoogleMeetSession[];
  transport: "chrome" | "chrome-node";
  lastCreatedBrowserTabUrl: string | undefined;
}): GoogleMeetTrackedRecoveryScope | undefined {
  const owned = params.sessions
    .filter((session) => session.state === "active" && session.transport === params.transport)
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
  if (owned) {
    return {
      mode: owned.mode,
      trackedMeetingUrl: owned.url,
      trackedTargetId: owned.chrome?.browserTab?.targetId,
      url: owned.url,
    };
  }
  return params.transport === "chrome-node" && params.lastCreatedBrowserTabUrl
    ? { url: params.lastCreatedBrowserTabUrl }
    : undefined;
}
