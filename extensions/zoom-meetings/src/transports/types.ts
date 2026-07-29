import type {
  MeetingBrowserTab,
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginJoinResult,
  MeetingPluginSession,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsMode, ZoomMeetingsTransport } from "../config.js";

export type ZoomMeetingsTranscriptSnapshot = MeetingTranscriptSnapshot;
export type ZoomMeetingsJoinRequest = MeetingPluginJoinRequest<
  ZoomMeetingsTransport,
  ZoomMeetingsMode
>;

type ZoomMeetingsManualActionReason =
  | "zoom-login-required"
  | "zoom-admission-required"
  | "zoom-permission-required"
  | "zoom-audio-choice-required"
  | "zoom-camera-required"
  | "zoom-microphone-required"
  | "zoom-passcode-required"
  | "zoom-captcha-required"
  | "zoom-session-conflict"
  | "browser-control-unavailable";

type ZoomMeetingsSpeechBlockedReason =
  | ZoomMeetingsManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "zoom-microphone-muted";

export type ZoomMeetingsChromeHealth = MeetingPluginChromeHealth<
  ZoomMeetingsManualActionReason,
  ZoomMeetingsSpeechBlockedReason
> & { meetingEnded?: boolean };
export type ZoomMeetingsBrowserTab = MeetingBrowserTab;
export type ZoomMeetingsSession = MeetingPluginSession<
  ZoomMeetingsTransport,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth
>;
export type ZoomMeetingsJoinResult = MeetingPluginJoinResult<ZoomMeetingsSession>;
