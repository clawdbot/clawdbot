// Google Meet type declarations define plugin contracts.
import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type {
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetModeInput,
  GoogleMeetTransport,
} from "../config.js";

export const GOOGLE_MEET_TRANSCRIPT_MAX_LINES = 2_000;

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

type GoogleMeetPluginConfig = GoogleMeetConfig & {
  chrome: GoogleMeetConfig["chrome"] & {
    audioInputCommand: string[];
    audioOutputCommand: string[];
  };
};

type GoogleMeetPluginTypes = ReturnType<
  typeof MeetingPlatformAdapter.pluginTypes<
    GoogleMeetPluginConfig,
    GoogleMeetTransport,
    GoogleMeetModeInput,
    GoogleMeetManualActionReason,
    GoogleMeetSpeechBlockedReason,
    {
      leaveReason?: string;
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
      lastSuppressedInputAt?: string;
      lastClearAt?: string;
      suppressedInputBytes?: number;
      consecutiveInputErrors?: number;
      lastInputError?: string;
      clearCount?: number;
      queuedInputChunks?: number;
    }
  >
>;

export type GoogleMeetTranscriptSnapshot = GoogleMeetPluginTypes["TranscriptSnapshot"];

export type GoogleMeetJoinRequest = GoogleMeetPluginTypes["JoinRequest"] & {
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

export type GoogleMeetChromeHealth = Omit<
  GoogleMeetPluginTypes["ChromeHealth"],
  "cameraOff" | "captionCaptureRequested" | "audioOutputRouteRetryable"
>;

export type GoogleMeetBrowserTab = GoogleMeetPluginTypes["BrowserTab"];

type GoogleMeetPluginSession = GoogleMeetPluginTypes["Session"];
type GoogleMeetPluginChrome = NonNullable<GoogleMeetPluginSession["chrome"]>;
type GoogleMeetPluginAudioBridge = NonNullable<GoogleMeetPluginChrome["audioBridge"]>;

export type GoogleMeetSession = Omit<GoogleMeetPluginSession, "chrome" | "mode"> & {
  mode: GoogleMeetMode;
  chrome?: Omit<GoogleMeetPluginChrome, "audioBridge" | "health"> & {
    audioBridge?: Omit<GoogleMeetPluginAudioBridge, "type"> & {
      type: GoogleMeetPluginAudioBridge["type"] | "external-command";
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

export type GoogleMeetJoinResult = Omit<GoogleMeetPluginTypes["JoinResult"], "session"> & {
  session: GoogleMeetSession;
};
