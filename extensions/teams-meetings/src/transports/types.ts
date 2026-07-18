import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { TeamsMeetingsMode, TeamsMeetingsTransport } from "../config.js";

export type TeamsMeetingsTranscriptSnapshot = MeetingTranscriptSnapshot;

export type TeamsMeetingsJoinRequest = {
  url: string;
  transport?: TeamsMeetingsTransport;
  mode?: TeamsMeetingsMode;
  message?: string;
  requesterSessionKey?: string;
  agentId?: string;
  timeoutMs?: number;
};

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

export type TeamsMeetingsChromeHealth = MeetingBrowserHealth<
  TeamsMeetingsManualActionReason,
  TeamsMeetingsSpeechBlockedReason
> & {
  inCall?: boolean;
  micMuted?: boolean;
  cameraOff?: boolean;
  lobbyWaiting?: boolean;
  audioInputRouted?: boolean;
  audioInputDeviceLabel?: string;
  audioInputRouteError?: string;
  audioOutputRouted?: boolean;
  audioOutputDeviceLabel?: string;
  audioOutputRouteError?: string;
  providerConnected?: boolean;
  realtimeReady?: boolean;
  audioInputActive?: boolean;
  audioOutputActive?: boolean;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastInputBytes?: number;
  lastOutputBytes?: number;
  bridgeClosed?: boolean;
  browserUrl?: string;
  browserTitle?: string;
  status?: string;
  notes?: string[];
};

export type TeamsMeetingsBrowserTab = MeetingBrowserTab;

export type TeamsMeetingsSession = MeetingSessionRecord<
  TeamsMeetingsTransport,
  TeamsMeetingsMode
> & {
  chrome?: {
    audioBackend: "blackhole-2ch";
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    browserTab?: TeamsMeetingsBrowserTab;
    audioBridge?: {
      type: "command-pair" | "node-command-pair";
      provider?: string;
    };
    health?: TeamsMeetingsChromeHealth;
  };
};

export type TeamsMeetingsJoinResult = {
  session: TeamsMeetingsSession;
  spoken?: boolean;
};
