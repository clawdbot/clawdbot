/**
 * Realtime voice output activity counters and playback-state tracking.
 *
 * Providers use this to decide whether assistant output is active,
 * interruptible, or overdue relative to the audio duration already emitted.
 */
export type RealtimeVoiceOutputActivityTrackerOptions = {
  /** Injectable clock for deterministic tests and playback watchdog math. */
  now?: () => number;
};

/** One output activity increment from source audio and/or sink audio. */
export type RealtimeVoiceOutputActivityDelta = {
  audioMs?: number;
  sourceAudioBytes?: number;
  sinkAudioBytes?: number;
};

/** Current output counters and playback timestamps. */
export type RealtimeVoiceOutputActivitySnapshot = {
  audioMs: number;
  chunks: number;
  sourceAudioBytes: number;
  sinkAudioBytes: number;
  playbackStarted: boolean;
  streamEnding: boolean;
  lastAudioAt?: number;
  playbackStartedAt?: number;
};

/** Mutable tracker for one realtime voice output stream. */
export type RealtimeVoiceOutputActivityTracker = {
  markStreamOpened(): void;
  markStreamEnding(): void;
  markPlaybackStarted(): void;
  markAudio(delta: RealtimeVoiceOutputActivityDelta): void;
  reset(): void;
  /** Whether output exists or the downstream sink reports active playback. */
  isActive(sinkActive?: boolean): boolean;
  /** Whether caller speech should be treated as interrupting current output. */
  isInterruptible(sinkActive?: boolean): boolean;
  elapsedPlaybackMs(): number;
  /** Delay before watchdog should assume playback has exceeded expected audio duration. */
  playbackWatchdogDelayMs(options: { marginMs: number; minMs?: number }): number | undefined;
  snapshot(): RealtimeVoiceOutputActivitySnapshot;
};

/** Create a fresh output activity tracker for a realtime voice session. */
export function createRealtimeVoiceOutputActivityTracker(
  options: RealtimeVoiceOutputActivityTrackerOptions = {},
): RealtimeVoiceOutputActivityTracker {
  const now = options.now ?? Date.now;
  let audioMs = 0;
  let chunks = 0;
  let sourceAudioBytes = 0;
  let sinkAudioBytes = 0;
  let playbackStarted = false;
  let streamEnding = false;
  let lastAudioAt: number | undefined;
  let playbackStartedAt: number | undefined;

  const snapshot = (): RealtimeVoiceOutputActivitySnapshot => ({
    audioMs,
    chunks,
    sourceAudioBytes,
    sinkAudioBytes,
    playbackStarted,
    streamEnding,
    ...(lastAudioAt === undefined ? {} : { lastAudioAt }),
    ...(playbackStartedAt === undefined ? {} : { playbackStartedAt }),
  });

  return {
    markStreamOpened() {
      // A new stream clears playback markers but keeps cumulative counters until
      // reset(), so callers can preserve total output stats across stream opens.
      streamEnding = false;
      playbackStarted = false;
      playbackStartedAt = undefined;
      lastAudioAt = undefined;
    },
    markStreamEnding() {
      streamEnding = true;
    },
    markPlaybackStarted() {
      if (playbackStarted) {
        return;
      }
      playbackStarted = true;
      playbackStartedAt = now();
    },
    markAudio(delta) {
      // Clamp negative/provider-buggy deltas to zero while still recording that
      // a chunk arrived.
      audioMs += Math.max(0, delta.audioMs ?? 0);
      sourceAudioBytes += Math.max(0, delta.sourceAudioBytes ?? 0);
      sinkAudioBytes += Math.max(0, delta.sinkAudioBytes ?? 0);
      chunks += 1;
      lastAudioAt = now();
    },
    reset() {
      audioMs = 0;
      chunks = 0;
      sourceAudioBytes = 0;
      sinkAudioBytes = 0;
      playbackStarted = false;
      streamEnding = false;
      lastAudioAt = undefined;
      playbackStartedAt = undefined;
    },
    isActive(sinkActive = false) {
      // Some sinks can report active playback before byte counters are visible.
      return sinkActive || chunks > 0;
    },
    isInterruptible(sinkActive = false) {
      return sinkActive || chunks > 0 || audioMs > 0;
    },
    elapsedPlaybackMs() {
      return playbackStartedAt === undefined ? 0 : now() - playbackStartedAt;
    },
    playbackWatchdogDelayMs({ marginMs, minMs = 1_000 }) {
      if (playbackStartedAt === undefined || audioMs <= 0) {
        return undefined;
      }
      // Watchdog waits for emitted audio duration plus margin, but never below
      // the configured minimum to avoid immediate false positives.
      return Math.max(minMs, audioMs - (now() - playbackStartedAt) + marginMs);
    },
    snapshot,
  };
}
