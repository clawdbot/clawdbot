import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
  type MeetingManualActionCategory,
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

function teamsMeetingOrigin(meetingUrl: string): string | undefined {
  try {
    const origin = new URL(meetingUrl).origin;
    return origin === "https://teams.microsoft.com" || origin === "https://teams.live.com"
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

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

function classifyManualActionReason(reason: string): MeetingManualActionCategory {
  switch (reason) {
    case "teams-login-required":
      return "login-required";
    case "teams-admission-required":
      return "admission-required";
    case "teams-permission-required":
      return "permission-required";
    case "teams-audio-choice-required":
      return "audio-choice-required";
    case "teams-session-conflict":
      return "session-conflict";
    case "browser-control-unavailable":
      return "browser-control-unavailable";
    default:
      return "custom";
  }
}

export const TEAMS_MEETINGS_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<TeamsMeetingsMode>,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot
>({
  id: "teams-meetings",
  displayName: "Microsoft Teams meetings",
  browserLabel: "Teams meeting",
  logScope: "[teams-meetings]",
  agentConsult: {
    surface: "a private Microsoft Teams meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: [
      "You are a behind-the-scenes consultant for a live meeting voice agent.",
      "Prioritize a fast, speakable answer over exhaustive investigation.",
      "Use only bounded, task-relevant tool calls.",
      "Never print secrets or dump environment variables.",
      "Be accurate, brief, and speakable.",
    ].join(" "),
  },
  session: {
    idPrefix: "teams_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Microsoft Teams guest in Chrome on a paired node"
        : "Microsoft Teams guest in the OpenClaw Chrome profile",
  },
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
        allowSessionAdoption: params.allowSessionAdoption,
        autoJoin: params.autoJoin,
        captureCaptions: params.captureCaptions,
        guestName: params.guestName,
        meetingSessionId: params.meetingSessionId || undefined,
        meetingUrl: params.url,
        readOnly: params.readOnly,
        waitForInCallMs: params.waitForInCallMs,
      }),
    shouldRetryJoinStatus: (health) =>
      health.inCall === true &&
      ((health.manualActionReason === "teams-audio-choice-required" &&
        health.audioInputRouted === true &&
        health.audioOutputRouteRetryable === true) ||
        (health.manualActionRequired !== true &&
          health.captionCaptureRequested === true &&
          health.captioning !== true)),
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish the Teams sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: (meetingUrl) =>
      teamsMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "",
        meetingUrl,
      }),
    buildSessionLeaveScript: teamsMeetingLeaveScript,
    captions: {
      // Durable notes observe the caption stream in every mode; live transcript
      // visibility remains gated by MeetingSessionRuntime.
      enabled: () => true,
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        teamsMeetingTranscriptScript(meetingUrl, meetingSessionId, finalize),
    },
    permissions: ({ allowMicrophone, meetingUrl }) => {
      const origin = teamsMeetingOrigin(meetingUrl);
      return allowMicrophone && origin
        ? {
            origin,
            permissions: ["audioCapture"],
            optionalPermissions: ["speakerSelection"],
          }
        : undefined;
    },
  },
  parsing: {
    classifyManualActionReason,
    displayName: "Teams",
    invalidTranscriptMessage: "Microsoft Teams transcript payload is invalid.",
    malformedStatusMessage: "Microsoft Teams browser status JSON is malformed.",
    malformedTranscriptMessage: "Microsoft Teams transcript JSON is malformed.",
  },
});
