import {
  MeetingPlatformAdapter,
  type MeetingBrowserJoinSession,
  type MeetingManualActionCategory,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsMode } from "../config.js";
import type { ZoomMeetingsChromeHealth, ZoomMeetingsTranscriptSnapshot } from "./types.js";
import {
  zoomMeetingLeaveScript,
  zoomMeetingStatusScript,
  zoomMeetingTranscriptScript,
} from "./zoom-meetings-page-scripts.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./zoom-meetings-platform-constants.js";
import {
  isRecoverableZoomMeetingTab,
  isSameZoomMeetingUrl,
  normalizeZoomMeetingUrl,
  normalizeZoomMeetingUrlForReuse,
} from "./zoom-meetings-urls.js";

function zoomMeetingOrigin(meetingUrl: string): string | undefined {
  return normalizeZoomMeetingUrlForReuse(meetingUrl) ? "https://app.zoom.us" : undefined;
}

export function isZoomMeetingsTalkBackMode(mode: ZoomMeetingsMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export function isZoomMeetingsRealtimeRouteReady(
  mode: ZoomMeetingsMode,
  health: ZoomMeetingsChromeHealth | undefined,
): boolean {
  return (
    isZoomMeetingsTalkBackMode(mode) &&
    health?.inCall === true &&
    health.micMuted === false &&
    health.audioInputRouted === true &&
    health.audioOutputRouted === true &&
    health.manualActionRequired !== true
  );
}

function classifyManualActionReason(reason: string): MeetingManualActionCategory {
  switch (reason) {
    case "zoom-login-required":
      return "login-required";
    case "zoom-admission-required":
    case "zoom-passcode-required":
    case "zoom-captcha-required":
      return "admission-required";
    case "zoom-permission-required":
      return "permission-required";
    case "zoom-audio-choice-required":
      return "audio-choice-required";
    case "zoom-session-conflict":
      return "session-conflict";
    case "browser-control-unavailable":
      return "browser-control-unavailable";
    default:
      return "custom";
  }
}

export const ZOOM_MEETINGS_PLATFORM_ADAPTER = MeetingPlatformAdapter.create<
  MeetingBrowserJoinSession<ZoomMeetingsMode>,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsTranscriptSnapshot
>({
  id: "zoom-meetings",
  displayName: "Zoom meetings",
  browserLabel: "Zoom meeting",
  logScope: "[zoom-meetings]",
  agentConsult: {
    surface: "a private Zoom meeting",
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
    idPrefix: "zoom_meeting",
    participantIdentity: (transport) =>
      transport === "chrome-node"
        ? "Zoom guest in Chrome on a paired node"
        : "Zoom guest in the OpenClaw Chrome profile",
  },
  nodeCommandName: ZOOM_MEETINGS_NODE_COMMAND,
  nodeConfigPath: "plugins.entries.zoom-meetings.config.chromeNode.node",
  urls: {
    validateAndNormalize: normalizeZoomMeetingUrl,
    normalizeForReuse: normalizeZoomMeetingUrlForReuse,
    isSameMeeting: isSameZoomMeetingUrl,
    buildJoinUrl: (session) => session.url,
    accountHint: () => undefined,
    isPreferredJoinUrl: (url) => Boolean(normalizeZoomMeetingUrlForReuse(url)),
    isRecoverableTab: isRecoverableZoomMeetingTab,
    localeAction: () => undefined,
  },
  browser: {
    allowsMicrophone: isZoomMeetingsTalkBackMode,
    buildStatusJoinScript: (params) =>
      zoomMeetingStatusScript({
        allowMicrophone: isZoomMeetingsTalkBackMode(params.mode),
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
      ((health.manualActionReason === "zoom-audio-choice-required" &&
        health.audioInputRouted === true &&
        health.audioOutputRouteRetryable === true) ||
        (health.manualActionRequired !== true &&
          health.captionCaptureRequested === true &&
          health.captioning !== true)),
    browserControlUnavailable: () => ({
      category: "browser-control-unavailable",
      reason: "browser-control-unavailable",
      message:
        "Open the OpenClaw browser profile, finish the Zoom sign-in, admission, or permission prompt, then retry.",
    }),
    buildLeaveScript: (meetingUrl) =>
      zoomMeetingLeaveScript({
        leaveInitiated: false,
        meetingSessionId: "",
        meetingUrl,
      }),
    buildSessionLeaveScript: zoomMeetingLeaveScript,
    captions: {
      // Durable notes observe the caption stream in every mode; live transcript
      // visibility remains gated by MeetingSessionRuntime.
      enabled: () => true,
      buildTranscriptScript: ({ finalize, meetingSessionId, meetingUrl }) =>
        zoomMeetingTranscriptScript(meetingUrl, meetingSessionId, finalize),
    },
    permissions: ({ allowMicrophone, meetingUrl }) => {
      const origin = zoomMeetingOrigin(meetingUrl);
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
    displayName: "Zoom",
    invalidTranscriptMessage: "Zoom transcript payload is invalid.",
    malformedStatusMessage: "Zoom browser status JSON is malformed.",
    malformedTranscriptMessage: "Zoom transcript JSON is malformed.",
    statusFields: (parsed) => ({
      meetingEnded: typeof parsed.meetingEnded === "boolean" ? parsed.meetingEnded : undefined,
    }),
  },
});
