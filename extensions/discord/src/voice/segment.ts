import path from "node:path";
import { Readable } from "node:stream";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordVoiceIngressContext, runDiscordVoiceAgentTurn } from "./ingress.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import {
  logVoiceVerbose,
  PLAYBACK_READY_TIMEOUT_MS,
  SPEAKING_READY_TIMEOUT_MS,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { synthesizeVoiceReplyAudio, transcribeVoiceAudio } from "./tts.js";

const VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS = 500;
const logger = createSubsystemLogger("discord/voice");

function formatVoiceTranscriptLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS)}...`;
}

export async function processDiscordVoiceSegment(params: {
  entry: VoiceSessionEntry;
  wavPath: string;
  userId: string;
  durationSeconds: number;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
  enqueuePlayback: (entry: VoiceSessionEntry, task: () => Promise<void>) => void;
}) {
  const { entry, wavPath, userId, durationSeconds } = params;
  logVoiceVerbose(
    `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  const ingress = await resolveDiscordVoiceIngressContext({
    entry,
    userId,
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    ownerAllowFrom: params.ownerAllowFrom,
    fetchGuildName: params.fetchGuildName,
    speakerContext: params.speakerContext,
  });
  if (!ingress) {
    logVoiceVerbose(
      `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  const transcript = await transcribeVoiceAudio({
    cfg: params.cfg,
    agentId: entry.route.agentId,
    filePath: wavPath,
  });
  if (!transcript) {
    logVoiceVerbose(
      `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  logVoiceVerbose(
    `transcript from ${ingress.speakerLabel} (${userId}) in guild ${entry.guildId} channel ${entry.channelId}: ${formatVoiceTranscriptLogPreview(transcript)}`,
  );

  const prompt = formatVoiceIngressPrompt(transcript, ingress.speakerLabel);
  const turn = await runDiscordVoiceAgentTurn({
    entry,
    userId,
    message: prompt,
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    runtime: params.runtime,
    context: ingress,
    ownerAllowFrom: params.ownerAllowFrom,
    fetchGuildName: params.fetchGuildName,
    speakerContext: params.speakerContext,
  });
  if (!turn) {
    logVoiceVerbose(
      `segment unauthorized before agent turn: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  const replyText = turn.text;

  if (!replyText) {
    logVoiceVerbose(
      `reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  const voiceReplyAudio = await synthesizeVoiceReplyAudio({
    cfg: params.cfg,
    override: params.discordConfig.voice?.tts,
    replyText,
    speakerLabel: ingress.speakerLabel,
  });
  if (voiceReplyAudio.status === "empty") {
    logVoiceVerbose(
      `tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  if (voiceReplyAudio.status === "failed") {
    logger.warn(`discord voice: TTS failed: ${voiceReplyAudio.error ?? "unknown error"}`);
    return;
  }
  logVoiceVerbose(
    `tts ok (${voiceReplyAudio.speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  params.enqueuePlayback(entry, async () => {
    const voiceSdk = loadDiscordVoiceSdk();
    const releaseAudioStream =
      voiceReplyAudio.mode === "stream" ? voiceReplyAudio.release : undefined;
    try {
      if (voiceReplyAudio.mode === "stream") {
        logVoiceVerbose(`playback start: guild ${entry.guildId} channel ${entry.channelId} stream`);
        const nodeStream = Readable.fromWeb(
          voiceReplyAudio.audioStream as import("node:stream/web").ReadableStream<Uint8Array>,
        );
        const resource = voiceSdk.createAudioResource(nodeStream);
        entry.player.play(resource);
      } else {
        logVoiceVerbose(
          `playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(voiceReplyAudio.audioPath)}`,
        );
        const resource = voiceSdk.createAudioResource(voiceReplyAudio.audioPath);
        entry.player.play(resource);
      }
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS)
        .catch(() => undefined);
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
        .catch(() => undefined);
      logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
    } finally {
      await releaseAudioStream?.();
    }
  });
}
