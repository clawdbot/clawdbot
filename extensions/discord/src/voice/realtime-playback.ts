import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  realtimeVoiceAudioDurationMs,
  resolveRealtimeVoiceBargeIn,
  type RealtimeVoiceActivationNameTranscriptResult,
  type RealtimeVoiceAudioChunkMetadata,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoicePlaybackItem,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { convertRealtimePcm24kMonoToDiscordPcm48kStereo } from "./audio.js";
import { DiscordRealtimeOutput } from "./realtime-output.js";
import type { DiscordRealtimePlayer } from "./realtime-player.js";
import type { DiscordVoiceMode, VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS = 5_000;
const DISCORD_REALTIME_MAX_RETAINED_RESPONSES = 32;
const DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES = 32 * 1024;
const DISCORD_REALTIME_WAKE_ACKS = ["Yeah.", "Mm-hmm.", "Got it.", "One sec."];
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
// Discord consumes one frame every 20 ms; cap retained-ahead PCM at two minutes.
const DISCORD_REALTIME_MAX_PENDING_OUTPUT_BYTES = DISCORD_RAW_PCM_FRAME_BYTES * 6_000;

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type RealtimeExactSpeechState =
  | { status: "idle" }
  | { status: "active"; message: string; output?: DiscordRealtimeOutput };

function normalizeControlSpeechText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
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
  private readonly outputs = new Set<DiscordRealtimeOutput>();
  private readonly generatingItems = new Map<string, RealtimeVoicePlaybackItem>();
  private generatingOutput: DiscordRealtimeOutput | undefined;
  private responseAudio: "accepting" | "discarding" | "completed" = "completed";
  private readonly unregisterPlayerLane: () => void;
  private queuedExactSpeechMessages: string[] = [];
  private exactSpeechState: RealtimeExactSpeechState = { status: "idle" };
  private wakeNameAckIndex = 0;
  private lastControlSpeech:
    | { normalizedText: string; sentAt: number; assistantTranscriptCount: number }
    | undefined;
  constructor(
    private readonly params: {
      bridge: () => RealtimeVoiceBridgeSession | null;
      bridgeReady: () => boolean;
      buildSpeakExactMessage: (text: string) => string;
      entry: VoiceSessionEntry;
      player: DiscordRealtimePlayer;
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
  ) {
    this.unregisterPlayerLane = this.params.player.registerLane({
      hasOutput: () => this.isOutputAudioActive(),
      onBargeIn: (reason) => this.handleBargeIn(reason),
      cancelForControl: () => this.cancelForControl(),
    });
  }

  close(): void {
    this.unregisterPlayerLane();
    this.queuedExactSpeechMessages = [];
    this.exactSpeechState = { status: "idle" };
    this.clearOutputAudio("session-close");
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
    // A native handler may decline short audio as echo. Providers without one
    // still need local interruption when another speaker owns the incoming audio.
    const bridge = this.params.bridge();
    this.params.harness.handleBargeIn({ audioPlaybackActive: true }, () => {
      if (!bridge?.bridge.handleBargeIn) {
        this.clearOutputAudio(reason);
      }
    });
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
    // Installed providers without playback snapshots retain the scalar clock contract.
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    return this.isOutputAudioActive();
  }

  getPlaybackState(): RealtimeVoicePlaybackItem[] {
    const items = new Set<RealtimeVoicePlaybackItem>();
    for (const output of this.outputs) {
      const outputItems = output.playbackItems();
      // A starved item precedes later items in its response, even after its
      // resource closes. Older completed responses still keep their queue position.
      if (outputItems.some((item) => this.generatingItems.get(item.itemId) === item)) {
        for (const item of this.generatingItems.values()) {
          items.add(item);
        }
      }
      for (const item of outputItems) {
        items.add(item);
      }
    }
    // Starvation can close a resource before its native response finishes. The
    // response retains consumed offsets until later PCM resumes or generation ends.
    for (const item of this.generatingItems.values()) {
      items.add(item);
    }
    return Array.from(items, (item) => ({ ...item, audioEndMs: Math.floor(item.audioEndMs) }));
  }

  beginResponse(): void {
    // Own a response before PCM arrives without reopening already cancelled output.
    if (this.responseAudio === "completed") {
      this.responseAudio = "accepting";
    }
  }

  sendOutputMark(acknowledge: () => void): void {
    if (!this.params.stopped() && this.responseAudio === "accepting") {
      this.generatingOutput?.markPlayback(acknowledge);
    }
  }

  sendOutputAudio(realtimePcm24kMono: Buffer, metadata?: RealtimeVoiceAudioChunkMetadata): void {
    this.params.markProviderGenerationObserved();
    if (this.params.stopped() || this.responseAudio === "discarding") {
      return;
    }
    const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
    if (discordPcm.length === 0) {
      return;
    }
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    const pendingBytes = Array.from(this.outputs).reduce(
      (total, output) => total + output.pendingBytes(),
      0,
    );
    if (
      discordPcm.length > DISCORD_REALTIME_MAX_PENDING_OUTPUT_BYTES - pendingBytes ||
      (!this.generatingOutput && this.outputs.size >= DISCORD_REALTIME_MAX_RETAINED_RESPONSES)
    ) {
      this.stopAfterPlaybackFailure(
        "output-audio-overflow",
        new Error(
          `Discord realtime audio playback overflow: responses=${this.outputs.size} pendingBytes=${pendingBytes} incomingBytes=${discordPcm.length}`,
        ),
      );
      return;
    }
    this.beginResponse();
    const output = this.generatingOutput ?? this.createOutput();
    const activity = {
      audioMs: realtimeVoiceAudioDurationMs(
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        realtimePcm24kMono.byteLength,
      ),
      sourceAudioBytes: realtimePcm24kMono.length,
      sinkAudioBytes: discordPcm.length,
    };
    let item: RealtimeVoicePlaybackItem | undefined;
    if (metadata) {
      item = this.generatingItems.get(metadata.itemId);
      if (!item) {
        item = { itemId: metadata.itemId, audioEndMs: 0 };
        this.generatingItems.set(metadata.itemId, item);
      }
    }
    // Observers may interrupt synchronously; publish ownership before notifying them.
    this.params.harness.recordOutputAudio(realtimePcm24kMono, activity);
    output.append(discordPcm, activity, item);
  }

  clearOutputAudio(reason = "clear"): void {
    if (this.responseAudio === "accepting") {
      this.responseAudio = "discarding";
    }
    this.generatingOutput = undefined;
    this.generatingItems.clear();
    const outputs = Array.from(this.outputs);
    this.outputs.clear();
    // Retire all source ownership and queued requests before stopping its player.
    for (const output of outputs.toReversed()) {
      output.close(reason);
    }
    this.params.harness.outputActivity.reset();
    this.completeExactSpeechResponse(reason);
  }

  handleResponseDone(outcome: {
    status: "completed" | "cancelled" | "failed" | "incomplete";
  }): void {
    const output = this.generatingOutput;
    this.generatingOutput = undefined;
    this.generatingItems.clear();
    this.responseAudio = "completed";
    // Generation ends before queued playback. Only this response may end its stream.
    output?.finish(outcome.status, outcome.status === "completed");
    this.completeExactSpeechResponse(outcome.status);
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
      retainedMessages >= DISCORD_REALTIME_MAX_RETAINED_RESPONSES ||
      retainedBytes + incomingBytes > DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES
    ) {
      // Completed speech cannot be silently dropped. Overflow terminally retires
      // this session before late provider or playback events can drain stale work.
      this.stopAfterPlaybackFailure(
        "exact-speech-overflow",
        new Error(
          `Discord realtime exact speech overflow: retained=${retainedMessages} retainedBytes=${retainedBytes} incomingBytes=${incomingBytes}`,
        ),
      );
      return;
    }
    if (
      !this.params.bridgeReady() ||
      this.responseAudio !== "completed" ||
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
      this.responseAudio !== "completed" ||
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
    if (this.params.player.isActive() || this.hasInterruptibleOutputAudio()) {
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
    this.params.player.cancelForControl();
    this.lastControlSpeech = {
      normalizedText: normalizeControlSpeechText(trimmed),
      sentAt: Date.now(),
      assistantTranscriptCount: 0,
    };
    this.enqueueExactSpeechMessage(trimmed);
  }

  private cancelForControl(): void {
    this.queuedExactSpeechMessages = [];
    this.exactSpeechState = { status: "idle" };
    // Idle providers may retain their last audio item; forcing interruption can truncate it.
    if (this.responseAudio === "completed" && this.outputs.size === 0) {
      return;
    }
    this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () =>
      this.clearOutputAudio("active-run-control"),
    );
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
      !this.exactSpeechState.output?.activity.snapshot().playbackStarted
        ? this.exactSpeechState.message
        : undefined;
    this.exactSpeechState = { status: "idle" };
    if (replayExactSpeech) {
      this.queuedExactSpeechMessages.unshift(replayExactSpeech);
    }
    this.responseAudio = "discarding";
    this.params.harness.flushOutput(() => this.clearOutputAudio(reason));
    this.responseAudio = "completed";
    this.params.harness.finishOutputAudio(reason);
  }

  outputAudioMs(): number {
    return Math.floor(this.params.harness.outputActivity.snapshot().audioMs);
  }

  isOutputAudioActive(): boolean {
    return this.outputs.size > 0 || this.generatingItems.size > 0;
  }

  private stopAfterPlaybackFailure(reason: string, error: Error): void {
    this.params.stopTerminally();
    this.queuedExactSpeechMessages = [];
    this.exactSpeechState = { status: "idle" };
    this.clearOutputAudio(reason);
    this.params.onTerminalError(error);
  }

  private createOutput(): DiscordRealtimeOutput {
    const logContext = `guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`;
    const output = new DiscordRealtimeOutput({
      player: this.params.player,
      logContext,
      onStart: () => {
        this.params.harness.outputActivity.markPlaybackStarted();
        const config = this.params.realtimeConfig();
        logger.info(
          `discord voice: realtime audio playback started ${logContext} mode=${this.params.mode} model=${config?.model ?? "provider-default"} voice=${config?.speakerVoice ?? config?.speakerVoiceId ?? "provider-default"}`,
        );
      },
      onClose: (closed, reason) => {
        if (!this.outputs.delete(closed)) {
          return;
        }
        if (this.generatingOutput === closed) {
          this.generatingOutput = undefined;
          // Starvation Idle allows the same response to resume; failed audio stays discarded.
          if (reason !== "player-idle") {
            this.responseAudio = "discarding";
          }
        }
        if (this.outputs.size === 0) {
          this.params.harness.outputActivity.reset();
        }
        this.completeExactSpeechResponse(reason);
      },
      onBargeIn: (reason) => this.handleBargeIn(reason),
      onError: (error) =>
        this.stopAfterPlaybackFailure(
          "output-playback-error",
          error instanceof Error ? error : new Error(formatErrorMessage(error)),
        ),
    });
    if (this.outputs.size === 0) {
      this.params.harness.outputActivity.markStreamOpened();
    }
    this.outputs.add(output);
    this.generatingOutput = output;
    if (this.exactSpeechState.status === "active") {
      this.exactSpeechState.output ??= output;
    }
    return output;
  }

  private sendExactSpeechMessage(text: string): void {
    if (this.params.stopped() || !text.trim()) {
      return;
    }
    this.exactSpeechState = { status: "active", message: text };
    this.beginResponse();
    this.params.bridge()?.sendUserMessage(this.params.buildSpeakExactMessage(text));
  }

  private completeExactSpeechResponse(reason: string): void {
    if (this.responseAudio !== "completed" || this.outputs.size > 0) {
      return;
    }
    this.exactSpeechState = { status: "idle" };
    this.drainQueuedExactSpeechMessages(reason);
  }
}
