import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { VOICE_WAV_HEADER_BYTES, writeVoiceWavFile } from "./audio.js";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import type { DiscordVoiceAudioReceipt, DiscordVoiceSegmentOutcome } from "./recording-types.js";
import { processDiscordVoiceSegment } from "./segment.js";
import type { VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const PCM_BYTES_PER_MILLISECOND = (48_000 * 2 * 2) / 1_000;
const MAX_PENDING_RECORDING_JOBS = 128;
const MAX_PENDING_RECORDING_BYTES = 64 * 1024 * 1024;
let pendingRecordingJobs = 0;
let pendingRecordingBytes = 0;

function reserveRecordingWav(bytes: number): () => void {
  // The file budget outlives individual transports and managers.
  if (
    pendingRecordingJobs >= MAX_PENDING_RECORDING_JOBS ||
    bytes > MAX_PENDING_RECORDING_BYTES - pendingRecordingBytes
  ) {
    throw new Error(
      "Discord voice recording backlog exceeded; wait for pending audio processing to finish, then speak again.",
    );
  }
  pendingRecordingJobs += 1;
  pendingRecordingBytes += bytes;
  return () => {
    pendingRecordingJobs -= 1;
    pendingRecordingBytes -= bytes;
  };
}

export class DiscordVoiceRecording {
  private readonly segmentBytes: number;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private chunked = false;
  private capture: VoiceSessionEntry["transcripts"];
  private startedAt = 0;
  private speaker: Promise<{ label: string }> | undefined;
  private overflow: Error | undefined;
  completion: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: {
      entry: VoiceSessionEntry;
      cfg: OpenClawConfig;
      userId: string;
      isInputComplete: () => boolean;
      minimumSeconds: () => number;
      canConverse: () => boolean;
      resolveIngressContext: () => Promise<DiscordVoiceIngressContext | null>;
      resolveSpeaker: () => Promise<{ label: string }>;
      onSegment: (outcome: Promise<DiscordVoiceSegmentOutcome>) => void;
      onExcluded: () => void;
    },
  ) {
    const budget = params.entry.audioInputBudget;
    // Include the WAV header and keep complete stereo PCM frames within the upload cap.
    this.segmentBytes = budget.enabled
      ? Math.max(
          0,
          Math.floor(
            (Math.min(budget.maxBytes, MAX_PENDING_RECORDING_BYTES) - VOICE_WAV_HEADER_BYTES) / 4,
          ) * 4,
        )
      : 0;
  }

  async append(pcm: Buffer, receipt: DiscordVoiceAudioReceipt): Promise<void> {
    if (!this.segmentBytes) {
      this.params.onExcluded();
      return;
    }
    this.chunked ||= receipt.capture !== undefined;
    if (receipt.capture !== this.capture) {
      await this.flush();
    }
    this.capture = receipt.capture;
    if (!this.capture?.isCurrent() && !this.params.canConverse()) {
      this.params.onExcluded();
      return;
    }
    if (!this.chunked && this.bytes + pcm.length > this.segmentBytes) {
      this.chunks = [];
      this.bytes = 0;
      this.overflow = new Error(
        "Discord voice audio exceeds the transcription limit; speak a shorter segment.",
      );
      logger.warn(`discord voice: ${this.overflow.message}`);
      throw this.overflow;
    }
    for (let offset = 0; offset < pcm.length;) {
      if (!this.bytes) {
        this.startedAt = receipt.startedAt + offset / PCM_BYTES_PER_MILLISECOND;
      }
      const length = Math.min(this.segmentBytes - this.bytes, pcm.length - offset);
      this.chunks.push(pcm.subarray(offset, offset + length));
      this.bytes += length;
      offset += length;
      if (this.chunked && this.bytes === this.segmentBytes) {
        await this.flush();
      }
    }
  }

  async finish(): Promise<void> {
    await this.flush();
    if (this.overflow) {
      throw this.overflow;
    }
  }

  private async flush(): Promise<void> {
    if (!this.bytes) {
      return;
    }
    const chunks = this.chunks;
    const bytes = this.bytes;
    const startedAt = this.startedAt;
    const capture = this.capture;
    this.chunks = [];
    this.bytes = 0;
    if (!this.params.isInputComplete() || (!capture?.isCurrent() && !this.params.canConverse())) {
      return;
    }
    if (!capture && bytes / (PCM_BYTES_PER_MILLISECOND * 1_000) < this.params.minimumSeconds()) {
      // Discarding a short uncaptured fragment makes the remaining utterance incomplete.
      this.params.onExcluded();
      return;
    }
    const recording = capture
      ? {
          capture,
          startedAt,
          speaker: (this.speaker ??= this.params.resolveSpeaker()),
        }
      : undefined;
    const releaseBudget = reserveRecordingWav(bytes + VOICE_WAV_HEADER_BYTES);
    let wav: Awaited<ReturnType<typeof writeVoiceWavFile>>;
    try {
      wav = await writeVoiceWavFile(Buffer.concat(chunks, bytes));
    } catch (error) {
      releaseBudget();
      throw error;
    }
    const cleanup = async () => {
      try {
        await wav.cleanup();
      } catch (error) {
        logger.warn(`discord voice: recording cleanup failed: ${formatErrorMessage(error)}`);
      } finally {
        releaseBudget();
      }
    };
    // Disk writes can outlive every owner; do not retain their WAV behind unrelated work.
    if (!this.params.isInputComplete() || (!capture?.isCurrent() && !this.params.canConverse())) {
      await cleanup();
      return;
    }
    const { entry } = this.params;
    const conversationOnly = createDeferred<void>();
    const previousProcessing = entry.processingQueue;
    const processing = (async (): Promise<DiscordVoiceSegmentOutcome> => {
      let outcome: DiscordVoiceSegmentOutcome = { status: "excluded" };
      try {
        await previousProcessing;
        outcome = await processDiscordVoiceSegment({
          entry,
          cfg: this.params.cfg,
          wavPath: wav.path,
          durationSeconds: wav.durationSeconds,
          userId: this.params.userId,
          resolveIngressContext: this.params.resolveIngressContext,
          isConversationCurrent: this.params.canConverse,
          onConversationOnly: () => conversationOnly.resolve(),
          recording,
        });
      } catch (error) {
        this.params.onExcluded();
        logger.warn(`discord voice: recording failed: ${formatErrorMessage(error)}`);
      } finally {
        await cleanup();
      }
      return outcome;
    })();
    // Register in audio order before work starts. A retired recorder releases its
    // queue slot, while the same operation retains the WAV for authorized conversation.
    this.params.onSegment(processing);
    this.completion = entry.processingQueue = Promise.race([
      processing.then(() => undefined),
      conversationOnly.promise,
    ]);
  }
}
