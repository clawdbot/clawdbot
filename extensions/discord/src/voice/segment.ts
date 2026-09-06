import { Readable } from "node:stream";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";
import { createDiscordOpusPlaybackStream } from "./audio.js";
import { type DiscordVoiceIngressContext, runDiscordVoiceAgentTurn } from "./ingress.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import type { DiscordVoiceSegmentOutcome } from "./recording-types.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { logVoiceVerbose, PLAYBACK_READY_TIMEOUT_MS, type VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { synthesizeVoiceReplyAudio, transcribeVoiceAudio } from "./tts.js";

const logger = createSubsystemLogger("discord/voice");

type DiscordVoiceResponseParams = {
  entry: VoiceSessionEntry;
  accountId: string;
  userId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  admissionAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
  enqueuePlayback: (entry: VoiceSessionEntry, task: () => Promise<void>) => void;
};

type DiscordVoiceSegmentParams = Pick<DiscordVoiceResponseParams, "entry" | "userId" | "cfg"> & {
  wavPath: string;
  durationSeconds: number;
  resolveIngressContext: () => Promise<DiscordVoiceIngressContext | null>;
  isConversationCurrent: () => boolean;
  onConversationOnly: () => void;
  recording?: {
    capture: NonNullable<VoiceSessionEntry["transcripts"]>;
    startedAt: number;
    speaker: Promise<{ label: string }>;
  };
};

export async function processDiscordVoiceSegment(
  params: DiscordVoiceSegmentParams,
): Promise<DiscordVoiceSegmentOutcome> {
  const { entry, wavPath, userId, durationSeconds } = params;
  const conversationCurrent = () =>
    !entry.captureOnly &&
    entry.sessionLifecycle.status === "active" &&
    params.isConversationCurrent();
  logVoiceVerbose(
    `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  // Recording owns STT; conversation authorization cannot hold the recording queue.
  const ingress = params.resolveIngressContext().catch((error: unknown) => {
    logger.warn(`discord voice: conversation authorization failed: ${formatErrorMessage(error)}`);
    return null;
  });
  const conversationAuthorized = ingress.then(
    (context) => Boolean(context) && conversationCurrent(),
  );
  const recording = params.recording;
  let admitted: DiscordVoiceIngressContext | null = null;
  if (!recording?.capture.isCurrent()) {
    params.onConversationOnly();
    admitted = await ingress;
  }
  if (!recording?.capture.isCurrent() && (!admitted || !conversationCurrent())) {
    logVoiceVerbose(
      `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return { status: "excluded" };
  }
  const speakerLabel = recording?.capture.isCurrent()
    ? (await recording.speaker).label
    : (admitted?.speakerLabel ?? userId);
  if (!recording?.capture.isCurrent()) {
    params.onConversationOnly();
    admitted = await ingress;
  }
  if (!recording?.capture.isCurrent() && (!admitted || !conversationCurrent())) {
    return { status: "excluded" };
  }
  const {
    text: transcript,
    processing,
    unavailable,
  } = await transcribeVoiceAudio({
    cfg: params.cfg,
    agentId: entry.route.agentId,
    filePath: wavPath,
  });
  if (unavailable) {
    recording?.capture.onBatchUnavailable?.();
    return { status: "unavailable" };
  }
  // Known omitted input cannot become a partial command. Completed silent input
  // remains empty, including CLI success without text and successful fallback.
  if (processing === "omitted") {
    return { status: "excluded" };
  }
  if (!transcript) {
    logVoiceVerbose(
      `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return { status: "empty", conversationAuthorized };
  }
  logVoiceVerbose(
    `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  logVoiceVerbose(
    `transcript from ${speakerLabel} (${userId}) in guild ${entry.guildId} channel ${entry.channelId}: ${formatVoiceLogPreview(transcript)}`,
  );
  if (recording?.capture.isCurrent()) {
    await recording.capture.onUtterance({
      sessionId: recording.capture.sessionId,
      startedAt: new Date(recording.startedAt).toISOString(),
      final: true,
      speaker: {
        id: userId,
        label: speakerLabel,
      },
      text: transcript,
      metadata: {
        channel: "discord",
        guildId: entry.guildId,
        channelId: entry.channelId,
        voiceSessionKey: entry.voiceSessionKey,
      },
    });
  }
  return { status: "transcribed", text: transcript, conversationAuthorized };
}

export async function respondToDiscordVoiceTranscript(
  params: DiscordVoiceResponseParams & {
    ingress: DiscordVoiceIngressContext;
    transcript: string;
  },
): Promise<void> {
  const { entry, ingress, transcript, userId } = params;
  const conversationCurrent = () =>
    !entry.captureOnly && entry.sessionLifecycle.status === "active";
  if (!conversationCurrent()) {
    return;
  }
  let replyText: string;
  const control = await maybeControlDiscordVoiceAgentRun({
    entry,
    text: transcript,
  }).catch((error: unknown) => {
    logger.warn(
      `discord voice: active-run control failed; falling back to normal segment handling: ${formatErrorMessage(error)}`,
    );
    return undefined;
  });

  if (control?.handled) {
    logger.info(
      `discord voice: active-run control handled mode=${control.result.mode} ok=${control.result.ok} active=${control.result.active} reason=${control.result.reason ?? "none"} session=${entry.route.sessionKey}`,
    );
    replyText = control.speakText ?? "";
  } else {
    const prompt = formatVoiceIngressPrompt(transcript, ingress.speakerLabel);
    const turn = await runDiscordVoiceAgentTurn({
      entry,
      accountId: params.accountId,
      userId,
      message: prompt,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
      runtime: params.runtime,
      context: ingress,
      admissionAllowFrom: params.admissionAllowFrom,
      fetchGuildName: params.fetchGuildName,
      speakerContext: params.speakerContext,
    });
    if (!turn) {
      logVoiceVerbose(
        `segment unauthorized before agent turn: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    replyText = turn.text;
  }

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
  const streamFailure = voiceReplyAudio.mode === "file" ? voiceReplyAudio.streamFailure : undefined;
  if (streamFailure && !entry.ttsStreamFallbackWarned) {
    entry.ttsStreamFallbackWarned = true;
    logger.warn(
      `discord voice: streaming TTS failed provider=${streamFailure.provider} reasonCode=${streamFailure.reasonCode}; using file fallback`,
    );
  }
  logVoiceVerbose(
    `tts ok (${voiceReplyAudio.speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  const releaseAudio =
    voiceReplyAudio.mode === "stream"
      ? voiceReplyAudio.release
      : () => unlinkIfExists(voiceReplyAudio.audioPath);
  // Synthesis can settle after leave; release before the playback queue gets ownership.
  if (entry.sessionLifecycle.status === "stopped") {
    await releaseAudio?.();
    return;
  }
  params.enqueuePlayback(entry, async () => {
    const voiceSdk = loadDiscordVoiceSdk();
    const playbackLifecycle = new AbortController();
    let playbackStarted = false;
    const cancelStoppedPlayback = () =>
      (!playbackStarted || entry.sessionLifecycle.status === "stopped") &&
      playbackLifecycle.abort();
    try {
      // Queued playback can outlive its session; a stopped player is reusable by the SDK.
      if (entry.sessionLifecycle.status === "stopped") {
        return;
      }
      entry.player.on(voiceSdk.AudioPlayerStatus.Idle, cancelStoppedPlayback);
      const input =
        voiceReplyAudio.mode === "stream"
          ? Readable.fromWeb(
              voiceReplyAudio.audioStream as import("node:stream/web").ReadableStream<Uint8Array>,
            )
          : voiceReplyAudio.audioPath;
      logVoiceVerbose(
        `playback start: guild ${entry.guildId} channel ${entry.channelId} ${voiceReplyAudio.mode}`,
      );
      const resource = voiceSdk.createAudioResource(createDiscordOpusPlaybackStream(input), {
        inputType: voiceSdk.StreamType.Opus,
      });
      entry.player.play(resource);
      await voiceSdk.entersState(
        entry.player,
        voiceSdk.AudioPlayerStatus.Playing,
        AbortSignal.any([AbortSignal.timeout(PLAYBACK_READY_TIMEOUT_MS), playbackLifecycle.signal]),
      );
      playbackStarted = true;
      // Playback has no duration cap; terminal stop emits Idle and cancels either lifecycle wait.
      await voiceSdk.entersState(
        entry.player,
        voiceSdk.AudioPlayerStatus.Idle,
        playbackLifecycle.signal,
      );
      logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
    } catch (error) {
      if (entry.sessionLifecycle.status !== "stopped") {
        throw error;
      }
    } finally {
      entry.player.off(voiceSdk.AudioPlayerStatus.Idle, cancelStoppedPlayback);
      await releaseAudio?.();
    }
  });
}
