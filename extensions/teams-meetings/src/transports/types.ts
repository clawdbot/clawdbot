import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "../config.js";

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

type TeamsMeetingsPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    TeamsMeetingsConfig,
    TeamsMeetingsTransport,
    TeamsMeetingsMode,
    TeamsMeetingsManualActionReason,
    TeamsMeetingsSpeechBlockedReason
  >
>;
export type TeamsMeetingsTranscriptSnapshot = TeamsMeetingsPluginTypes["TranscriptSnapshot"];
export type TeamsMeetingsJoinRequest = TeamsMeetingsPluginTypes["JoinRequest"];
export type TeamsMeetingsChromeHealth = TeamsMeetingsPluginTypes["ChromeHealth"];
export type TeamsMeetingsSession = TeamsMeetingsPluginTypes["Session"];
