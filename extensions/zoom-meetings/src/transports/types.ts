import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "../config.js";

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

type ZoomMeetingsPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    ZoomMeetingsConfig,
    ZoomMeetingsTransport,
    ZoomMeetingsMode,
    ZoomMeetingsManualActionReason,
    ZoomMeetingsSpeechBlockedReason,
    { meetingEnded?: boolean }
  >
>;
export type ZoomMeetingsTranscriptSnapshot = ZoomMeetingsPluginTypes["TranscriptSnapshot"];
export type ZoomMeetingsJoinRequest = ZoomMeetingsPluginTypes["JoinRequest"];
export type ZoomMeetingsChromeHealth = ZoomMeetingsPluginTypes["ChromeHealth"];
export type ZoomMeetingsSession = ZoomMeetingsPluginTypes["Session"];
