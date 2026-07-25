// Google Meet type declarations define plugin contracts.
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
  MeetingTranscriptSnapshot,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { GoogleMeetMode, GoogleMeetModeInput, GoogleMeetTransport } from "../config.js";

export const GOOGLE_MEET_TRANSCRIPT_MAX_LINES = 2_000;

export type GoogleMeetTranscriptSnapshot = MeetingTranscriptSnapshot;

export type GoogleMeetJoinRequest = {
  url: string;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetModeInput;
  message?: string;
  requesterSessionKey?: string;
  /** Agent selected by the calling tool context. */
  agentId?: string;
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
  | "meet-locale-required"
  | "meet-session-conflict"
  | "browser-control-unavailable";

type GoogleMeetSpeechBlockedReason =
  | GoogleMeetManualActionReason
  | "not-in-call"
  | "browser-unverified"
  | "audio-bridge-unavailable"
  | "meet-microphone-muted";

export type GoogleMeetChromeHealth = MeetingBrowserHealth<
  GoogleMeetManualActionReason,
  GoogleMeetSpeechBlockedReason
> & {
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

export type GoogleMeetBrowserTab = MeetingBrowserTab;

export type GoogleMeetSession = MeetingSessionRecord<
  GoogleMeetTransport,
  GoogleMeetMode,
  {
    enabled: boolean;
    strategy?: string;
    provider?: string;
    model?: string;
    transcriptionProvider?: string;
    toolPolicy: string;
  }
> & {
  /** Canonical agent owner and shared fields retain their byte-compatible wire names. */
  chrome?: {
    audioBackend: "blackhole-2ch";
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    /** Exact joined tab and whether OpenClaw may close it on leave. */
    browserTab?: GoogleMeetBrowserTab;
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
};

export type GoogleMeetJoinResult = {
  session: GoogleMeetSession;
  spoken?: boolean;
};
