import { PassThrough, pipeline } from "node:stream";
import type { AudioResource } from "@discordjs/voice";
import {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityDelta,
  type RealtimeVoicePlaybackItem,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { createDiscordOpusEncodeStream } from "./audio.js";
import type { DiscordRealtimePlayer, DiscordRealtimePlayerRequest } from "./realtime-player.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
const DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES = 25;
// Leave room for the realtime player's two-second missed-frame tolerance.
const DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS = 3_000;

/** One output stream retains ownership through queued and audible playback. */
export class DiscordRealtimeOutput {
  readonly activity = createRealtimeVoiceOutputActivityTracker();
  private readonly stream = new PassThrough({ highWaterMark: DISCORD_RAW_PCM_FRAME_BYTES * 128 });
  private request: DiscordRealtimePlayerRequest | undefined;
  private resource: AudioResource | undefined;
  private playbackMarks: Array<{ endMs: number; acknowledge: () => void }> = [];
  private reportedPlaybackMs = 0;
  private readonly audioSpans: Array<{
    item: RealtimeVoicePlaybackItem;
    startMs: number;
    endMs: number;
  }> = [];
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private drainHandler: (() => void) | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private failed = false;

  constructor(
    private readonly params: {
      player: DiscordRealtimePlayer;
      logContext: string;
      onStart: () => void;
      onClose: (output: DiscordRealtimeOutput, reason: string) => void;
      onBargeIn: (reason: string) => void;
      onError: (error: unknown) => void;
    },
  ) {
    this.stream.once("close", () => {
      // Encoding can finish before the player consumes the resource. Idle owns
      // completion after playback starts, even if the PCM stream has closed.
      if (!this.activity.snapshot().playbackStarted) {
        this.close("stream-close");
      }
    });
  }

  pendingBytes(): number {
    return this.closed
      ? 0
      : this.bufferedBytes + this.stream.writableLength + this.stream.readableLength;
  }

  playbackItems(): RealtimeVoicePlaybackItem[] {
    // Resource duration counts consumed Opus packets, excluding buffering and SDK
    // silence. Clamp the padded last packet to PCM, and retain progress across starvation.
    const playedMs = Math.min(
      this.resource?.playbackDuration ?? 0,
      this.activity.snapshot().audioMs,
    );
    for (const span of this.audioSpans) {
      span.item.audioEndMs += Math.max(
        0,
        Math.min(playedMs, span.endMs) - Math.max(this.reportedPlaybackMs, span.startMs),
      );
    }
    this.reportedPlaybackMs = playedMs;
    // Fully consumed PCM must not be truncated during the SDK's trailing silence.
    // The response owner separately retains unfinished items through starvation.
    return this.audioSpans.filter(({ endMs }) => endMs > playedMs).map(({ item }) => item);
  }

  markPlayback(acknowledge: () => void): void {
    if (!this.closed) {
      this.playbackMarks.push({ endMs: this.activity.snapshot().audioMs, acknowledge });
    }
  }

  append(
    pcm: Buffer,
    activity: RealtimeVoiceOutputActivityDelta & { audioMs: number },
    item?: RealtimeVoicePlaybackItem,
  ): void {
    if (this.closed) {
      return;
    }
    const startMs = this.activity.snapshot().audioMs;
    if (item) {
      const previous = this.audioSpans.at(-1);
      const endMs = startMs + activity.audioMs;
      if (previous?.item === item && previous.endMs === startMs) {
        previous.endMs = endMs;
      } else {
        this.audioSpans.push({ item, startMs, endMs });
      }
    }
    this.activity.markAudio(activity);
    if (this.activity.snapshot().playbackStarted && !this.drainHandler) {
      // A false write return accepts this chunk; only later chunks are queued.
      if (!this.stream.write(pcm)) {
        this.waitForDrain();
      }
      return;
    }
    this.buffers.push(pcm);
    this.bufferedBytes += pcm.length;
    if (
      !this.drainHandler &&
      this.bufferedBytes >= DISCORD_RAW_PCM_FRAME_BYTES * DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES
    ) {
      this.startPlayback();
    }
  }

  finish(reason: string, playBuffered: boolean): void {
    if (this.closed) {
      return;
    }
    this.activity.markStreamEnding();
    const activity = this.activity.snapshot();
    logger.info(
      `discord voice: realtime audio playback finishing reason=${reason} ${this.params.logContext} audioMs=${Math.floor(activity.audioMs)} chunks=${activity.chunks}`,
    );
    if (!playBuffered) {
      this.close(reason);
      return;
    }
    this.startPlayback();
    if (this.activity.snapshot().playbackStarted) {
      this.scheduleWatchdog(reason);
      if (!this.drainHandler) {
        this.stream.end();
      }
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    const consumedMs = this.resource?.playbackDuration ?? 0;
    const playbackRetirement =
      reason === "player-idle" ||
      reason === "output-pipeline-error" ||
      reason === "playback-watchdog";
    const heardMarks = playbackRetirement
      ? this.playbackMarks.filter((mark) => mark.endMs <= consumedMs)
      : [];
    const lostPlaybackMarks =
      playbackRetirement && this.playbackMarks.some((mark) => mark.endMs > consumedMs);
    this.closed = true;
    this.playbackMarks = [];
    this.playbackItems();
    this.clearWatchdog();
    const activity = this.activity.snapshot();
    logger.info(
      `discord voice: realtime audio playback stopped reason=${reason} ${this.params.logContext} audioMs=${Math.floor(activity.audioMs)} elapsedMs=${this.activity.elapsedPlaybackMs()} chunks=${activity.chunks} discordBytes=${activity.sinkAudioBytes} realtimeBytes=${activity.sourceAudioBytes}`,
    );
    this.buffers = [];
    this.bufferedBytes = 0;
    if (this.drainHandler) {
      this.stream.off("drain", this.drainHandler);
      this.drainHandler = undefined;
    }
    this.stream.end();
    this.stream.destroy();
    if (lostPlaybackMarks) {
      this.params.onError(
        new Error(`Discord realtime audio stopped before playback completed: ${reason}`),
      );
    }
    // Retire the exact output before stop can synchronously grant another one.
    this.params.onClose(this, reason);
    if (this.request) {
      this.params.player.cancel(this.request);
      this.request = undefined;
    }
    // Idle can retire the resource before its final read microtask. Preserve
    // heard acknowledgments after retirement, never report discarded PCM as played.
    try {
      for (const mark of heardMarks) {
        mark.acknowledge();
      }
    } catch (error) {
      this.params.onError(error);
    }
  }

  private startPlayback(): void {
    if (this.closed || this.request) {
      return;
    }
    this.request = {
      createResource: () => this.createResource(),
      onStart: () => {
        this.activity.markPlaybackStarted();
        this.params.onStart();
        if (this.activity.snapshot().streamEnding) {
          this.scheduleWatchdog("player-start");
          if (!this.drainHandler) {
            this.stream.end();
          }
        }
      },
      onIdle: () => this.close(this.failed ? "output-pipeline-error" : "player-idle"),
      onBargeIn: this.params.onBargeIn,
      onError: this.params.onError,
    };
    this.params.player.enqueue(this.request);
  }

  private createResource() {
    const voiceSdk = loadDiscordVoiceSdk();
    const opusStream = createDiscordOpusEncodeStream();
    // The SDK emits Idle on error before the pipeline completion callback runs.
    opusStream.once("error", () => {
      this.failed = true;
    });
    pipeline(this.stream, opusStream, (error) => {
      if (!error || this.closed) {
        return;
      }
      logger.warn(
        `discord voice: realtime output pipeline failed ${this.params.logContext}: ${formatErrorMessage(error)}`,
      );
      this.close("output-pipeline-error");
    });
    const buffered = Buffer.concat(this.buffers, this.bufferedBytes);
    this.buffers = [];
    this.bufferedBytes = 0;
    if (buffered.length > 0 && !this.stream.write(buffered)) {
      this.waitForDrain();
    }
    this.resource = voiceSdk.createAudioResource(opusStream, {
      inputType: voiceSdk.StreamType.Opus,
    });
    const read = this.resource.read.bind(this.resource);
    this.resource.read = () => {
      const packet = read();
      if (this.playbackMarks.length > 0) {
        // Finish the SDK's packet preparation before an acknowledgment can start
        // another response or synchronously cancel this output.
        queueMicrotask(() => this.acknowledgePlayedMarks());
      }
      return packet;
    };
    return this.resource;
  }

  private acknowledgePlayedMarks(): void {
    try {
      while (!this.closed) {
        const mark = this.playbackMarks[0];
        if (!mark || mark.endMs > (this.resource?.playbackDuration ?? 0)) {
          return;
        }
        this.playbackMarks.shift();
        mark.acknowledge();
      }
    } catch (error) {
      this.params.onError(error);
    }
  }

  private waitForDrain(): void {
    if (this.drainHandler || this.closed) {
      return;
    }
    logger.info(
      `discord voice: realtime audio playback buffering ${this.params.logContext} bufferedBytes=${this.stream.writableLength + this.stream.readableLength}`,
    );
    this.drainHandler = () => {
      this.drainHandler = undefined;
      if (this.closed) {
        return;
      }
      let refreshWatchdog = this.activity.snapshot().streamEnding;
      while (this.buffers.length > 0) {
        const buffered = this.buffers.shift();
        if (!buffered) {
          break;
        }
        this.bufferedBytes -= buffered.length;
        const writable = this.stream.write(buffered);
        if (refreshWatchdog) {
          this.scheduleWatchdog("output-drain");
          refreshWatchdog = false;
        }
        if (!writable) {
          this.waitForDrain();
          return;
        }
      }
      if (this.activity.snapshot().streamEnding) {
        this.stream.end();
      }
    };
    this.stream.once("drain", this.drainHandler);
  }

  private scheduleWatchdog(reason: string): void {
    this.clearWatchdog();
    const timeoutMs = this.activity.playbackWatchdogDelayMs({
      marginMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
      minMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
    });
    if (timeoutMs === undefined) {
      return;
    }
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      logger.warn(
        `discord voice: realtime audio playback watchdog fired reason=${reason} ${this.params.logContext} audioMs=${Math.floor(this.activity.snapshot().audioMs)} elapsedMs=${this.activity.elapsedPlaybackMs()}`,
      );
      this.close("playback-watchdog");
    }, timeoutMs);
  }

  private clearWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }
}
