import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { ChannelType } from "../internal/discord.js";
import type { VoiceCaptureState } from "./capture-state.js";
import type { VoiceReceiveRecoveryState } from "./receive-recovery.js";

export const MIN_SEGMENT_SECONDS = 0.35;
export const CAPTURE_FINALIZE_GRACE_MS = 2_500;
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

export type VoiceSessionEntry = {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sessionChannelId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  connection: import("@discordjs/voice").VoiceConnection;
  player: import("@discordjs/voice").AudioPlayer;
  playbackQueue: Promise<void>;
  processingQueue: Promise<void>;
  capture: VoiceCaptureState;
  receiveRecovery: VoiceReceiveRecoveryState;
  stop: () => void;
};

export function logVoiceVerbose(message: string): void {
  logVerbose(`discord voice: ${message}`);
}

export function isVoiceChannel(type: ChannelType): boolean {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
