import type { TranscriptUtterance } from "openclaw/plugin-sdk/transcripts";

export type DiscordVoiceTranscriptCapture = {
  sessionId: string;
  warning?: string;
  isCurrent: () => boolean;
  onBatchUnavailable?: () => void;
  onUtterance: (utterance: TranscriptUtterance) => void | Promise<void>;
};

export type DiscordVoiceAudioReceipt = {
  capture: DiscordVoiceTranscriptCapture | undefined;
  startedAt: number;
};

export type DiscordVoiceSegmentOutcome =
  | { status: "transcribed"; text: string; conversationAuthorized: Promise<boolean> }
  | { status: "excluded" }
  | { status: "unavailable" }
  | { status: "empty"; conversationAuthorized: Promise<boolean> };
