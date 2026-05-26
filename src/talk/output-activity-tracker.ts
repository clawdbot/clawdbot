export type RealtimeVoiceOutputActivityTrackerOptions = {
  now?: () => number;
};

export type RealtimeVoiceOutputActivityDelta = {
  audioMs?: number;
  sourceAudioBytes?: number;
  sinkAudioBytes?: number;
};

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

export type RealtimeVoiceOutputActivityTracker = {
  markStreamOpened(): void;
  markStreamEnding(): void;
  markPlaybackStarted(): void;
  markAudio(delta: RealtimeVoiceOutputActivityDelta): void;
  reset(): void;
  isActive(sinkActive?: boolean): boolean;
  isInterruptible(sinkActive?: boolean): boolean;
  elapsedPlaybackMs(): number;
  playbackWatchdogDelayMs(options: { marginMs: number; minMs?: number }): number | undefined;
  snapshot(): RealtimeVoiceOutputActivitySnapshot;
};

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
      return Math.max(minMs, audioMs - (now() - playbackStartedAt) + marginMs);
    },
    snapshot,
  };
}
