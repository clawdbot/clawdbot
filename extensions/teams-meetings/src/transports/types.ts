import type {
  MeetingBrowserTab,
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginJoinResult,
  MeetingPluginSession,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsMode, TeamsMeetingsTransport } from "../config.js";

export type TeamsMeetingsTranscriptSnapshot = MeetingTranscriptSnapshot;
export type TeamsMeetingsJoinRequest = MeetingPluginJoinRequest<
  TeamsMeetingsTransport,
  TeamsMeetingsMode
>;

type TeamsMeetingsManualActionReason =
  | "teams-login-required"
  | "teams-admission-required"
  | "teams-permission-required"
  | "teams-audio-choice-required"
  | "teams-camera-required"
  | "teams-microphone-required"
  | "teams-session-conflict"
  | "browser-control-unavailable";

type TeamsMeetingsSpeechBlockedReason =
  | TeamsMeetingsManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "teams-microphone-muted";

export type TeamsMeetingsChromeHealth = MeetingPluginChromeHealth<
  TeamsMeetingsManualActionReason,
  TeamsMeetingsSpeechBlockedReason
>;
export type TeamsMeetingsBrowserTab = MeetingBrowserTab;
export type TeamsMeetingsSession = MeetingPluginSession<
  TeamsMeetingsTransport,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth
>;
export type TeamsMeetingsJoinResult = MeetingPluginJoinResult<TeamsMeetingsSession>;
