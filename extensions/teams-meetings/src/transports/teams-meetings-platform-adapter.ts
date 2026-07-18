import type {
  MeetingBrowserJoinSession,
  MeetingManualActionCategory,
  MeetingPlatformAdapter,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsMode } from "../config.js";
import {
  teamsMeetingLeaveScript,
  teamsMeetingStatusScript,
  teamsMeetingTranscriptScript,
} from "./teams-meetings-page-scripts.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./teams-meetings-platform-constants.js";
import {
  isRecoverableTeamsMeetingTab,
  isSameTeamsMeetingUrl,
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
} from "./teams-meetings-urls.js";
import type { TeamsMeetingsChromeHealth, TeamsMeetingsTranscriptSnapshot } from "./types.js";

export function isTeamsMeetingsTalkBackMode(mode: TeamsMeetingsMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export function isTeamsMeetingsRealtimeRouteReady(
  mode: TeamsMeetingsMode,
  health: TeamsMeetingsChromeHealth | undefined,
): boolean {
  return (
    isTeamsMeetingsTalkBackMode(mode) &&
    health?.inCall === true &&
    health.micMuted === false &&
    health.audioInputRouted === true &&
    health.audioOutputRouted === true &&
    health.manualActionRequired !== true
  );
}

function parseBrowserStatus(result: unknown): TeamsMeetingsChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record.result) as Record<string, unknown>;
  } catch {
    throw new Error("Microsoft Teams browser status JSON is malformed.");
  }
  return {
    inCall: typeof parsed.inCall === "boolean" ? parsed.inCall : undefined,
    micMuted: typeof parsed.micMuted === "boolean" ? parsed.micMuted : undefined,
    cameraOff: typeof parsed.cameraOff === "boolean" ? parsed.cameraOff : undefined,
    lobbyWaiting: typeof parsed.lobbyWaiting === "boolean" ? parsed.lobbyWaiting : undefined,
    audioInputRouted:
      typeof parsed.audioInputRouted === "boolean" ? parsed.audioInputRouted : undefined,
    audioInputDeviceLabel:
      typeof parsed.audioInputDeviceLabel === "string" ? parsed.audioInputDeviceLabel : undefined,
    audioInputRouteError:
      typeof parsed.audioInputRouteError === "string" ? parsed.audioInputRouteError : undefined,
    audioOutputRouted:
      typeof parsed.audioOutputRouted === "boolean" ? parsed.audioOutputRouted : undefined,
    audioOutputDeviceLabel:
      typeof parsed.audioOutputDeviceLabel === "string" ? parsed.audioOutputDeviceLabel : undefined,
    audioOutputRouteError:
      typeof parsed.audioOutputRouteError === "string" ? parsed.audioOutputRouteError : undefined,
    manualActionRequired:
      typeof parsed.manualActionRequired === "boolean" ? parsed.manualActionRequired : undefined,
    manualActionReason:
      typeof parsed.manualActionReason === "string"
        ? (parsed.manualActionReason as TeamsMeetingsChromeHealth["manualActionReason"])
        : undefined,
    manualActionMessage:
      typeof parsed.manualActionMessage === "string" ? parsed.manualActionMessage : undefined,
    browserUrl: typeof parsed.url === "string" ? parsed.url : undefined,
    browserTitle: typeof parsed.title === "string" ? parsed.title : undefined,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
  };
}

function classifyManualAction(health: TeamsMeetingsChromeHealth) {
  if (!health.manualActionRequired || !health.manualActionReason || !health.manualActionMessage) {
    return undefined;
  }
  const category: MeetingManualActionCategory =
    health.manualActionReason === "teams-login-required"
      ? "login-required"
      : health.manualActionReason === "teams-admission-required"
        ? "admission-required"
        : health.manualActionReason === "teams-permission-required"
          ? "permission-required"
          : health.manualActionReason === "teams-audio-choice-required"
            ? "audio-choice-required"
            : health.manualActionReason === "teams-session-conflict"
              ? "session-conflict"
              : health.manualActionReason === "browser-control-unavailable"
                ? "browser-control-unavailable"
                : "custom";
  return {
    category,
    reason: health.manualActionReason,
    message: health.manualActionMessage,
  };
}

function parseLeaveResult(result: unknown): {
  departed: boolean;
  leaveAction?: "leave" | "confirm";
  urlMatched?: boolean;
} {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(record.result) as Record<string, unknown>;
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

function parseTranscript(result: unknown) {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (typeof record.result !== "string" || !record.result.trim()) {
    return { droppedLines: 0, lines: [] };
  }
  try {
    const parsed = JSON.parse(record.result) as Record<string, unknown>;
    return {
      droppedLines: 0,
      lines: [],
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
      ...(typeof parsed.sessionMatched === "boolean"
        ? { sessionMatched: parsed.sessionMatched }
        : {}),
    };
  } catch {
    throw new Error("Microsoft Teams transcript JSON is malformed.");
  }
}

export const TEAMS_MEETINGS_PLATFORM_ADAPTER: MeetingPlatformAdapter<
  MeetingBrowserJoinSession<TeamsMeetingsMode>,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot
> = {
  id: "teams-meetings",
  displayName: "Microsoft Teams meetings",
  browserLabel: "Teams meeting",
  logScope: "[teams-meetings]",
  nodeCommandName: TEAMS_MEETINGS_NODE_COMMAND,
  nodeConfigPath: "plugins.entries.teams-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeTeamsMeetingUrl,
    normalizeForReuse: normalizeTeamsMeetingUrlForReuse,
    isSameMeeting: isSameTeamsMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeTeamsMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableTeamsMeetingTab,
    localeAction: () => undefined,
  },
  browser: {
    allowsMicrophone: isTeamsMeetingsTalkBackMode,
    buildStatusJoinScript: (params) =>
      teamsMeetingStatusScript({
        allowMicrophone: isTeamsMeetingsTalkBackMode(params.mode),
        autoJoin: params.autoJoin,
        guestName: params.guestName,
        meetingSessionId: params.meetingSessionId || undefined,
        meetingUrl: params.url,
        readOnly: params.readOnly,
      }),
    parseStatus: parseBrowserStatus,
    classifyManualAction,
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish the Teams sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: teamsMeetingLeaveScript,
    parseLeaveResult,
    captions: {
      // Teams caption DOM is not enabled until a live tenant flow validates stable selectors.
      enabled: () => false,
      buildTranscriptScript: ({ meetingSessionId, meetingUrl }) =>
        teamsMeetingTranscriptScript(meetingUrl, meetingSessionId),
      parseTranscript,
    },
    // The core permission hook has no meeting URL, so it cannot select between
    // teams.microsoft.com and teams.live.com without guessing an origin.
    permissions: () => undefined,
    permissionNotes: ({ allowMicrophone }) =>
      allowMicrophone
        ? ["Teams media permissions are handled in the browser when prompted."]
        : ["Observe-only mode does not request Teams microphone access."],
  },
};
