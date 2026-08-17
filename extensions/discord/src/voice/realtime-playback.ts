import { PassThrough, pipeline } from "node:stream";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveRealtimeVoiceBargeIn,
  type RealtimeVoiceActivationNameTranscriptResult,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  createDiscordOpusEncodeStream,
  convertRealtimePcm24kMonoToDiscordPcm48kStereo,
} from "./audio.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import type { DiscordVoiceMode, VoiceSessionEntry } from "./session.js";
import { logVoiceVerbose } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS = 5_000;
const DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS = 1_500;
const DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_MESSAGES = 32;
const DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES = 32 * 1024;
const DISCORD_REALTIME_CANCELLATION_RACE_DETAIL = "Cancellation failed: no active response found";
const DISCORD_REALTIME_WAKE_ACKS = ["Yeah.", "Mm-hmm.", "Got it.", "One sec."];
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
const DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES = 25;

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type RealtimePlaybackState =
  | { status: "idle" }
  | { status: "buffering"; stream: PassThrough }
  | { status: "playing"; stream: PassThrough }
  | { status: "backpressured"; stream: PassThrough; token: symbol };

type RealtimeExactSpeechState =
  | { status: "idle" }
  | { status: "active"; message: string; audioStarted: boolean };

function isRealtimeResponseCancellationRace(event: RealtimeVoiceBridgeEvent): boolean {
  return (
    event.direction === "server" &&
    event.type === "error" &&
    event.detail === DISCORD_REALTIME_CANCELLATION_RACE_DETAIL
  );
}

function normalizeControlSpeechText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function pcm16MonoDurationMs(audio: Buffer, sampleRate: number): number {
  if (audio.length === 0 || sampleRate <= 0) {
    return 0;
  }
  const samples = audio.length / REALTIME_PCM16_BYTES_PER_SAMPLE;
  return (samples * 1000) / sampleRate;
}

export type DiscordRealtimePlaybackPort = Pick<
  DiscordRealtimePlayback<unknown>,
  | "enqueueExactSpeechMessage"
  | "handleBargeIn"
  | "hasInterruptibleOutputAudio"
  | "isBargeInEnabled"
  | "isOutputAudioActive"
  | "outputAudioMs"
  | "retainedExactSpeechTexts"
  | "sendWakeNameAck"
  | "speakControlResult"
>;

export class DiscordRealtimePlayback<TState> {
  private outputStream: PassThrough | null = null;
  private outputPlaybackWatchdog: ReturnType<typeof setTimeout> | undefined;
  private outputPacedBuffer: Buffer = Buffer.alloc(0);
  private playbackState: RealtimePlaybackState = { status: "idle" };
  private queuedExactSpeechMessages: string[] = [];
  private exactSpeechState: RealtimeExactSpeechState = { status: "idle" };
  private wakeNameAckIndex = 0;
  private lastControlSpeech:
    | { normalizedText: string; sentAt: number; assistantTranscriptCount: number }
    | undefined;
  private readonly playerIdleHandler = () => {
    const hadOutputAudio = this.isOutputAudioActive();
    this.resetOutputStream("player-idle");
    if (hadOutputAudio) {
      this.completeExactSpeechResponse("player-idle");
    }
  };

  constructor(
    private readonly params: {
      bridge: () => RealtimeVoiceBridgeSession | null;
      bridgeReady: () => boolean;
      buildSpeakExactMessage: (text: string) => string;
      entry: VoiceSessionEntry;
      harness: RealtimeVoiceSessionHarness<TState>;
      markProviderGenerationObserved: () => void;
      mode: Exclude<DiscordVoiceMode, "stt-tts">;
      onTerminalError: (error: Error) => void;
      providerId: () => string | undefined;
      realtimeConfig: () => DiscordRealtimeVoiceConfig;
      stopTerminally: () => void;
      stopped: () => boolean;
      wakeNameRequired: () => boolean;
    },
  ) {}

  attachPlayer(): void {
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.on(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
  }

  close(): void {
    this.playbackState = { status: "idle" };
    this.queuedExactSpeechMessages = [];
    this.exactSpeechState = { status: "idle" };
    this.clearOutputAudio("session-close");
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.off(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
  }

  handleBargeIn(reason = "barge-in"): void {
    if (!this.isBargeInEnabled()) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} bargeIn=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
      );
      return;
    }
    const outputActive = this.hasInterruptibleOutputAudio();
    if (!outputActive) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} outputActive=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} playbackChunks=${this.params.harness.outputActivity.snapshot().chunks}`,
      );
      return;
    }
    logger.info(
      `discord voice: realtime barge-in requested reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.params.harness.outputActivity.snapshot().chunks}`,
    );
    // Provider owns barge-in truncation. If audio is below minBargeInAudioEndMs,
    // shipped behavior leaves local playback intact, so the fallback must not clear it.
    this.params.harness.handleBargeIn({ audioPlaybackActive: true }, () => {});
  }

  isBargeInEnabled(): boolean {
    if (this.params.wakeNameRequired()) {
      return false;
    }
    const providerId =
      this.params.providerId() ?? this.params.realtimeConfig()?.provider ?? "openai";
    const realtimeConfig = this.params.realtimeConfig();
    return resolveRealtimeVoiceBargeIn({
      configuredBargeIn: realtimeConfig?.bargeIn,
      interruptResponseOnInputAudio:
        realtimeConfig?.providers?.[providerId]?.interruptResponseOnInputAudio,
    });
  }

  hasInterruptibleOutputAudio(): boolean {
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    const streamActive = Boolean(this.outputStream && !this.outputStream.destroyed);
    return this.params.harness.outputActivity.isInterruptible(streamActive);
  }

  sendOutputAudio(realtimePcm24kMono: Buffer): void {
    this.params.markProviderGenerationObserved();
    if (this.params.stopped() || this.playbackState.status === "backpressured") {
      return;
    }
    const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
    if (discordPcm.length === 0) {
      return;
    }
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    if (this.params.harness.outputActivity.snapshot().streamEnding) {
      logVoiceVerbose(
        `realtime output audio ignored after stream ending: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId}`,
      );
      return;
    }
    const stream = this.ensureOutputStream();
    if (this.exactSpeechState.status === "active") {
      this.exactSpeechState = { ...this.exactSpeechState, audioStarted: true };
    }
    this.params.harness.recordOutputAudio(realtimePcm24kMono, {
      audioMs: pcm16MonoDurationMs(realtimePcm24kMono, 24_000),
      sourceAudioBytes: realtimePcm24kMono.length,
      sinkAudioBytes: discordPcm.length,
    });
    this.queueOutputAudio(stream, discordPcm);
  }

  clearOutputAudio(reason = "clear"): void {
    this.resetOutputStream(reason);
    this.params.entry.player.stop(true);
  }

  finishOutputAudioStream(
    reason: string,
    { playBuffered = true }: { playBuffered?: boolean } = {},
  ): void {
    const stream = this.outputStream;
    if (!stream || stream.destroyed || this.params.harness.outputActivity.snapshot().streamEnding) {
      return;
    }
    this.params.harness.outputActivity.markStreamEnding();
    logger.info(
      `discord voice: realtime audio playback finishing reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${this.outputAudioMs()} chunks=${this.params.harness.outputActivity.snapshot().chunks}`,
    );
    if (playBuffered) {
      this.startOutputPlayback(stream);
      this.scheduleOutputPlaybackWatchdog(reason, stream);
    } else {
      this.resetOutputStream(reason);
      this.params.entry.player.stop(true);
      this.completeExactSpeechResponse(reason);
      return;
    }
    stream.end();
  }

  handleProviderEvent(event: RealtimeVoiceBridgeEvent): void {
    const responseCancellationRaced =
      this.playbackState.status === "backpressured" && isRealtimeResponseCancellationRace(event);
    if (!responseCancellationRaced) {
      return;
    }
    const outputBackpressured = this.playbackState.status === "backpressured";
    if (outputBackpressured) {
      this.playbackState = { status: "idle" };
    }
    if (
      this.exactSpeechState.status === "active" &&
      (outputBackpressured || !this.exactSpeechState.audioStarted)
    ) {
      this.completeExactSpeechResponse(event.type);
    }
    this.finishOutputAudioStream(event.type, { playBuffered: false });
  }

  handleResponseDone(outcome: {
    status: "completed" | "cancelled" | "failed" | "incomplete";
  }): void {
    const outputBackpressured = this.playbackState.status === "backpressured";
    if (outputBackpressured) {
      this.playbackState = { status: "idle" };
    }
    if (
      this.exactSpeechState.status === "active" &&
      (outputBackpressured || !this.exactSpeechState.audioStarted)
    ) {
      this.completeExactSpeechResponse(outcome.status);
    }
    this.finishOutputAudioStream(outcome.status, {
      playBuffered: outcome.status === "completed",
    });
  }

  enqueueExactSpeechMessage(text: string): void {
    if (this.params.stopped() || !text.trim()) {
      return;
    }
    const retainedMessages =
      this.queuedExactSpeechMessages.length + (this.exactSpeechState.status === "active" ? 1 : 0);
    const retainedBytes =
      this.queuedExactSpeechMessages.reduce(
        (total, message) => total + Buffer.byteLength(message, "utf8"),
        0,
      ) +
      Buffer.byteLength(
        this.exactSpeechState.status === "active" ? this.exactSpeechState.message : "",
        "utf8",
      );
    const incomingBytes = Buffer.byteLength(text, "utf8");
    if (
      retainedMessages >= DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_MESSAGES ||
      retainedBytes + incomingBytes > DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES
    ) {
      // Completed speech cannot be silently dropped. Overflow terminally retires
      // this session before late provider or playback events can drain stale work.
      this.params.stopTerminally();
      this.queuedExactSpeechMessages = [];
      this.exactSpeechState = { status: "idle" };
      this.clearOutputAudio("exact-speech-overflow");
      this.params.onTerminalError(
        new Error(
          `Discord realtime exact speech overflow: retained=${retainedMessages} retainedBytes=${retainedBytes} incomingBytes=${incomingBytes}`,
        ),
      );
      return;
    }
    if (
      !this.params.bridgeReady() ||
      this.exactSpeechState.status === "active" ||
      this.hasInterruptibleOutputAudio()
    ) {
      this.queuedExactSpeechMessages.push(text);
      logger.info(
        `discord voice: realtime exact speech queued guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()}`,
      );
      return;
    }
    this.sendExactSpeechMessage(text);
  }

  retainedExactSpeechTexts(): string[] {
    return [
      ...(this.exactSpeechState.status === "active" ? [this.exactSpeechState.message] : []),
      ...this.queuedExactSpeechMessages,
    ];
  }

  drainQueuedExactSpeechMessages(reason: string): void {
    if (
      this.params.stopped() ||
      !this.params.bridgeReady() ||
      this.exactSpeechState.status === "active" ||
      this.queuedExactSpeechMessages.length === 0 ||
      this.hasInterruptibleOutputAudio()
    ) {
      return;
    }
    const next = this.queuedExactSpeechMessages.shift();
    if (!next) {
      return;
    }
    logger.info(
      `discord voice: realtime exact speech dequeued reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length}`,
    );
    this.sendExactSpeechMessage(next);
  }

  sendWakeNameAck(result: RealtimeVoiceActivationNameTranscriptResult): void {
    if (!result.allowed || this.params.stopped() || this.exactSpeechState.status === "active") {
      return;
    }
    if (this.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime wake-name ack skipped outputActive=true voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return;
    }
    const ack =
      DISCORD_REALTIME_WAKE_ACKS[this.wakeNameAckIndex % DISCORD_REALTIME_WAKE_ACKS.length];
    this.wakeNameAckIndex += 1;
    logger.info(
      `discord voice: realtime wake-name ack canonical=${result.activationName} heard=${result.heardName} match=${result.match} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
    this.enqueueExactSpeechMessage(ack ?? "Yeah.");
  }

  speakControlResult(text: string): void {
    const trimmed = text.trim();
    if (this.params.stopped() || !trimmed) {
      return;
    }
    this.queuedExactSpeechMessages = [];
    this.completeExactSpeechResponse("active-run-control", { drain: false });
    this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () =>
      this.clearOutputAudio("active-run-control"),
    );
    this.lastControlSpeech = {
      normalizedText: normalizeControlSpeechText(trimmed),
      sentAt: Date.now(),
      assistantTranscriptCount: 0,
    };
    this.enqueueExactSpeechMessage(trimmed);
  }

  suppressDuplicateControlSpeech(text: string): void {
    const recent = this.lastControlSpeech;
    if (!recent) {
      return;
    }
    if (Date.now() - recent.sentAt > DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS) {
      this.lastControlSpeech = undefined;
      return;
    }
    if (normalizeControlSpeechText(text) !== recent.normalizedText) {
      return;
    }
    recent.assistantTranscriptCount += 1;
    if (recent.assistantTranscriptCount <= 1) {
      return;
    }
    logger.info(
      `discord voice: realtime duplicate active-run control speech suppressed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
    );
    this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () =>
      this.clearOutputAudio("duplicate-active-run-control"),
    );
  }

  resetProviderContinuity(reason: string): void {
    this.lastControlSpeech = undefined;
    const replayExactSpeech =
      this.exactSpeechState.status === "active" &&
      !this.params.harness.outputActivity.snapshot().playbackStarted
        ? this.exactSpeechState.message
        : undefined;
    this.exactSpeechState = { status: "idle" };
    if (replayExactSpeech) {
      this.queuedExactSpeechMessages.unshift(replayExactSpeech);
    }
    this.params.harness.flushOutput(() => this.clearOutputAudio(reason));
    this.params.harness.finishOutputAudio(reason);
  }

  outputAudioMs(): number {
    return Math.floor(this.params.harness.outputActivity.snapshot().audioMs);
  }

  isOutputAudioActive(): boolean {
    return this.params.harness.outputActivity.isActive(
      Boolean(this.outputStream && !this.outputStream.destroyed),
    );
  }

  currentOutputStream(): PassThrough | null {
    return this.outputStream;
  }

  private ensureOutputStream(): PassThrough {
    if (this.outputStream && !this.outputStream.destroyed && !this.outputStream.writableEnded) {
      return this.outputStream;
    }
    const stream = new PassThrough({ highWaterMark: DISCORD_RAW_PCM_FRAME_BYTES * 128 });
    this.outputStream = stream;
    this.playbackState = { status: "buffering", stream };
    this.outputPacedBuffer = Buffer.alloc(0);
    this.params.harness.outputActivity.markStreamOpened();
    stream.once("close", () => {
      // After playback starts this PCM stream can close before Discord consumes
      // the Opus resource; idle/watchdog owns active playback cleanup.
      if (this.params.harness.outputActivity.snapshot().playbackStarted) {
        return;
      }
      this.handleOutputStreamClosed(stream, "stream-close");
    });
    return stream;
  }

  private handleOutputStreamClosed(stream: PassThrough, reason: string): void {
    if (this.outputStream !== stream) {
      return;
    }
    this.logOutputAudioStopped(reason);
    this.clearOutputPlaybackWatchdog();
    this.outputStream = null;
    if (this.playbackState.status !== "backpressured") {
      this.playbackState = { status: "idle" };
    }
    this.outputPacedBuffer = Buffer.alloc(0);
    this.params.harness.outputActivity.reset();
    // The Opus resource can close without Discord emitting player idle. This
    // close path releases queued exact speech, so clear the old watchdog before
    // the next response owns exact-speech state.
    this.completeExactSpeechResponse(reason);
  }

  private queueOutputAudio(stream: PassThrough, discordPcm: Buffer): void {
    if (this.playbackState.status === "playing") {
      if (!stream.write(discordPcm)) {
        this.handleOutputBackpressure(stream);
      }
      return;
    }
    this.outputPacedBuffer =
      this.outputPacedBuffer.length > 0
        ? Buffer.concat([this.outputPacedBuffer, discordPcm])
        : discordPcm;
    if (
      this.outputPacedBuffer.length >=
      DISCORD_RAW_PCM_FRAME_BYTES * DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES
    ) {
      this.startOutputPlayback(stream);
    }
  }

  private handleOutputBackpressure(stream: PassThrough): void {
    if (this.playbackState.status === "backpressured" || this.outputStream !== stream) {
      return;
    }
    const token = Symbol("output-backpressure");
    this.playbackState = { status: "backpressured", stream, token };
    const bufferedBytes = stream.writableLength + stream.readableLength;
    logger.warn(
      `discord voice: realtime audio playback backpressured guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} bufferedBytes=${bufferedBytes}`,
    );
    this.clearOutputAudio("output-backpressure");
    queueMicrotask(() => {
      if (
        this.params.stopped() ||
        this.playbackState.status !== "backpressured" ||
        this.playbackState.token !== token
      ) {
        return;
      }
      this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () => {});
    });
  }

  private startOutputPlayback(stream: PassThrough): void {
    if (this.params.harness.outputActivity.snapshot().playbackStarted || stream.destroyed) {
      return;
    }
    const voiceSdk = loadDiscordVoiceSdk();
    const opusStream = createDiscordOpusEncodeStream();
    opusStream.on("error", (err) => {
      logger.warn(
        `discord voice: realtime opus encode failed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}: ${formatErrorMessage(err)}`,
      );
      this.resetOutputStream("opus-encode-error");
    });
    opusStream.once("close", () => this.handleOutputStreamClosed(stream, "stream-close"));
    pipeline(stream, opusStream, (err) => {
      if (!err) {
        return;
      }
      logger.warn(
        `discord voice: realtime output pipeline failed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}: ${formatErrorMessage(err)}`,
      );
      this.resetOutputStream("output-pipeline-error");
    });
    if (this.outputPacedBuffer.length > 0) {
      stream.write(this.outputPacedBuffer);
      this.outputPacedBuffer = Buffer.alloc(0);
    }
    const resource = voiceSdk.createAudioResource(opusStream, {
      inputType: voiceSdk.StreamType.Opus,
    });
    this.params.entry.player.play(resource);
    this.params.harness.outputActivity.markPlaybackStarted();
    this.playbackState = { status: "playing", stream };
    const realtimeConfig = this.params.realtimeConfig();
    logger.info(
      `discord voice: realtime audio playback started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} mode=${this.params.mode} model=${realtimeConfig?.model ?? "provider-default"} voice=${realtimeConfig?.speakerVoice ?? realtimeConfig?.speakerVoiceId ?? "provider-default"}`,
    );
  }

  private resetOutputStream(reason = "reset"): void {
    const stream = this.outputStream;
    this.clearOutputPlaybackWatchdog();
    this.logOutputAudioStopped(reason);
    this.outputStream = null;
    if (this.playbackState.status !== "backpressured") {
      this.playbackState = { status: "idle" };
    }
    this.outputPacedBuffer = Buffer.alloc(0);
    this.params.harness.outputActivity.reset();
    stream?.end();
    stream?.destroy();
  }

  private scheduleOutputPlaybackWatchdog(reason: string, stream: PassThrough): void {
    this.clearOutputPlaybackWatchdog();
    const timeoutMs = this.params.harness.outputActivity.playbackWatchdogDelayMs({
      marginMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
    });
    if (timeoutMs === undefined) {
      return;
    }
    this.outputPlaybackWatchdog = setTimeout(() => {
      this.outputPlaybackWatchdog = undefined;
      if (this.outputStream && this.outputStream !== stream) {
        return;
      }
      if (!this.outputStream && !this.isOutputAudioActive()) {
        this.completeExactSpeechResponse("playback-watchdog");
        return;
      }
      logger.warn(
        `discord voice: realtime audio playback watchdog fired reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${this.outputAudioMs()} elapsedMs=${this.params.harness.outputActivity.elapsedPlaybackMs()}`,
      );
      this.clearOutputAudio("playback-watchdog");
      this.completeExactSpeechResponse("playback-watchdog");
    }, timeoutMs);
  }

  private clearOutputPlaybackWatchdog(): void {
    if (!this.outputPlaybackWatchdog) {
      return;
    }
    clearTimeout(this.outputPlaybackWatchdog);
    this.outputPlaybackWatchdog = undefined;
  }

  private sendExactSpeechMessage(text: string): void {
    if (this.params.stopped() || !text.trim()) {
      return;
    }
    this.exactSpeechState = { status: "active", message: text, audioStarted: false };
    this.params.bridge()?.sendUserMessage(this.params.buildSpeakExactMessage(text));
  }

  private completeExactSpeechResponse(reason: string, options?: { drain?: boolean }): void {
    if (this.exactSpeechState.status === "idle" && this.queuedExactSpeechMessages.length === 0) {
      return;
    }
    this.exactSpeechState = { status: "idle" };
    if (options?.drain === false) {
      return;
    }
    this.drainQueuedExactSpeechMessages(reason);
  }

  private logOutputAudioStopped(reason: string): void {
    const activity = this.params.harness.outputActivity.snapshot();
    const audioMs = Math.floor(activity.audioMs);
    const chunks = activity.chunks;
    const discordBytes = activity.sinkAudioBytes;
    const realtimeBytes = activity.sourceAudioBytes;
    const elapsedMs = this.params.harness.outputActivity.elapsedPlaybackMs();
    if (this.outputStream || chunks > 0 || audioMs > 0) {
      logger.info(
        `discord voice: realtime audio playback stopped reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${audioMs} elapsedMs=${elapsedMs} chunks=${chunks} discordBytes=${discordBytes} realtimeBytes=${realtimeBytes}`,
      );
    }
  }
}
