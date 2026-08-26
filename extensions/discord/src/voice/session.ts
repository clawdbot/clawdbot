// Discord plugin module implements session behavior.
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TranscriptUtterance } from "openclaw/plugin-sdk/transcripts";
import { ChannelType } from "../internal/discord.js";
import type { VoiceCaptureState } from "./capture-state.js";
import type { VoiceReceiveRecoveryState } from "./receive-recovery.js";

export const MIN_SEGMENT_SECONDS = 0.35;
export const CAPTURE_FINALIZE_GRACE_MS = 2_000;
export const VOICE_CONNECT_READY_TIMEOUT_MS = 30_000;
export const VOICE_RECONNECT_GRACE_MS = 15_000;
export const PLAYBACK_READY_TIMEOUT_MS = 60_000;
export const SPEAKING_READY_TIMEOUT_MS = 60_000;

export function resolveVoiceTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.floor(value);
}

export type VoiceOperationResult = {
  ok: boolean;
  message: string;
  channelId?: string;
  guildId?: string;
};

export type VoiceJoinOptions = {
  preserveFollowState?: boolean;
  autoJoinWhenOccupied?: boolean;
  transcripts?: VoiceSessionEntry["transcripts"];
};

export type VoiceSessionGeneration = {
  generation: number;
  isCurrent: () => boolean;
};

export type DiscordVoiceMode = "stt-tts" | "agent-proxy" | "bidi";

export function resolveDiscordVoiceMode(voice: DiscordAccountConfig["voice"]): DiscordVoiceMode {
  const mode = voice?.mode;
  if (mode === "stt-tts" || mode === "bidi") {
    return mode;
  }
  return "agent-proxy";
}

export function isDiscordRealtimeVoiceMode(
  mode: DiscordVoiceMode,
): mode is Exclude<DiscordVoiceMode, "stt-tts"> {
  return mode === "agent-proxy" || mode === "bidi";
}

export type VoiceRealtimeSpeakerContext = {
  extraSystemPrompt?: string;
  senderIsOwner: boolean;
  speakerLabel: string;
};

export type VoiceRealtimeAgentTurnParams = {
  context: VoiceRealtimeSpeakerContext;
  message: string;
  toolsAllow?: string[];
  userId: string;
};

export type VoiceRealtimeSpeakerTurn = {
  close: () => void;
  sendInputAudio: (discordPcm48kStereo: Buffer) => void;
};

export type VoiceRealtimeSession = {
  beginSpeakerTurn: (
    context: VoiceRealtimeSpeakerContext,
    userId: string,
  ) => VoiceRealtimeSpeakerTurn;
  close: () => void;
  connect: () => Promise<void>;
  handleBargeIn: (reason?: string) => void;
  isBargeInEnabled: () => boolean;
};

type VoiceRealtimeLifecycle =
  | { status: "inactive"; generation: number }
  | { status: "starting"; generation: number; instance: VoiceRealtimeSession }
  | { status: "active"; generation: number; instance: VoiceRealtimeSession }
  | { status: "stopped"; generation: number; reason: string };

export type VoiceSessionEntry = {
  generation: number;
  autoJoinWhenOccupied: boolean;
  sessionLifecycle: { status: "active" } | { status: "stopped"; reason: string };
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sessionChannelId: string;
  voiceSessionKey: string;
  route: ReturnType<typeof resolveAgentRoute>;
  connection: import("@discordjs/voice").VoiceConnection;
  player: import("@discordjs/voice").AudioPlayer;
  playbackQueue: Promise<void>;
  processingQueue: Promise<void>;
  ttsStreamFallbackWarned: boolean;
  capture: VoiceCaptureState;
  realtimeLifecycle: VoiceRealtimeLifecycle;
  transcripts?: {
    sessionId: string;
    onUtterance: (utterance: TranscriptUtterance) => void | Promise<void>;
  };
  receiveRecovery: VoiceReceiveRecoveryState;
  stop: (reason?: string) => void;
};

export function logVoiceVerbose(message: string): void {
  logVerbose(`discord voice: ${message}`);
}

export function isVoiceChannel(type: ChannelType): boolean {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
