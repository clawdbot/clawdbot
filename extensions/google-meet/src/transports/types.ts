import type { GoogleMeetMode, GoogleMeetTransport } from "../config.js";

export type GoogleMeetSessionState = "active" | "ended";

export type GoogleMeetJoinRequest = {
  url: string;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

export type GoogleMeetManualActionReason =
  | "google-login-required"
  | "meet-admission-required"
  | "meet-permission-required"
  | "meet-audio-choice-required"
  | "browser-control-unavailable";

export type GoogleMeetSpeechBlockedReason =
  | GoogleMeetManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable";

export type GoogleMeetChromeHealth = {
  inCall?: boolean;
  micMuted?: boolean;
  manualActionRequired?: boolean;
  manualActionReason?: GoogleMeetManualActionReason;
  manualActionMessage?: string;
  speechReady?: boolean;
  speechBlockedReason?: GoogleMeetSpeechBlockedReason;
  speechBlockedMessage?: string;
  providerConnected?: boolean;
  realtimeReady?: boolean;
  audioInputActive?: boolean;
  audioOutputActive?: boolean;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastClearAt?: string;
  lastInputBytes?: number;
  lastOutputBytes?: number;
  consecutiveInputErrors?: number;
  lastInputError?: string;
  clearCount?: number;
  queuedInputChunks?: number;
  browserUrl?: string;
  browserTitle?: string;
  bridgeClosed?: boolean;
  status?: string;
  notes?: string[];
};

export type GoogleMeetSession = {
  id: string;
  url: string;
  transport: GoogleMeetTransport;
  mode: GoogleMeetMode;
  state: GoogleMeetSessionState;
  createdAt: string;
  updatedAt: string;
  participantIdentity: string;
  realtime: {
    enabled: boolean;
    provider?: string;
    model?: string;
    toolPolicy: string;
  };
  chrome?: {
    audioBackend: "blackhole-2ch";
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    audioBridge?: {
      type: "command-pair" | "node-command-pair" | "external-command";
      provider?: string;
    };
    health?: GoogleMeetChromeHealth;
  };
  twilio?: {
    dialInNumber: string;
    pinProvided: boolean;
    dtmfSequence?: string;
    voiceCallId?: string;
    dtmfSent?: boolean;
  };
  notes: string[];
};

export type GoogleMeetJoinResult = {
  session: GoogleMeetSession;
  spoken?: boolean;
};
