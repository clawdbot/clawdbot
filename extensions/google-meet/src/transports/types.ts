import type { GoogleMeetMode, GoogleMeetModeInput, GoogleMeetTransport } from "../config.js";

type GoogleMeetSessionState = "active" | "ended";

export type GoogleMeetJoinRequest = {
  url: string;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetModeInput;
  message?: string;
  requesterSessionKey?: string;
  timeoutMs?: number;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

type GoogleMeetManualActionReason =
  | "google-login-required"
  | "meet-admission-required"
  | "meet-permission-required"
  | "meet-audio-choice-required"
  | "browser-control-unavailable";

type GoogleMeetSpeechBlockedReason =
  | GoogleMeetManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "meet-microphone-muted";

export type GoogleMeetChromeHealth = {
  inCall?: boolean;
  micMuted?: boolean;
  lobbyWaiting?: boolean;
  leaveReason?: string;
  captioning?: boolean;
  captionsEnabledAttempted?: boolean;
  transcriptLines?: number;
  lastCaptionAt?: string;
  lastCaptionSpeaker?: string;
  lastCaptionText?: string;
  recentTranscript?: Array<{
    at?: string;
    speaker?: string;
    text: string;
  }>;
  realtimeTranscriptLines?: number;
  lastRealtimeTranscriptAt?: string;
  lastRealtimeTranscriptRole?: "user" | "assistant";
  lastRealtimeTranscriptText?: string;
  recentRealtimeTranscript?: Array<{
    at: string;
    role: "user" | "assistant";
    text: string;
  }>;
  lastRealtimeEventAt?: string;
  lastRealtimeEventType?: string;
  lastRealtimeEventDetail?: string;
  recentRealtimeEvents?: Array<{
    at: string;
    direction: "client" | "server";
    type: string;
    detail?: string;
  }>;
  recentTalkEvents?: Array<{
    id: string;
    type: string;
    sessionId: string;
    turnId?: string;
    seq: number;
    timestamp: string;
    final?: boolean;
  }>;
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
  audioOutputRouted?: boolean;
  audioOutputDeviceLabel?: string;
  audioOutputRouteError?: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastSuppressedInputAt?: string;
  lastClearAt?: string;
  lastInputBytes?: number;
  lastOutputBytes?: number;
  suppressedInputBytes?: number;
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
    strategy?: string;
    provider?: string;
    model?: string;
    transcriptionProvider?: string;
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
    introSent?: boolean;
  };
  notes: string[];
};

export type GoogleMeetJoinResult = {
  session: GoogleMeetSession;
  spoken?: boolean;
};
