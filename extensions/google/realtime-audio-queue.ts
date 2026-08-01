const GOOGLE_REALTIME_MAX_PENDING_AUDIO_CHUNKS = 320;
const GOOGLE_REALTIME_MAX_PENDING_AUDIO_BYTES = 1024 * 1024;

type GoogleRealtimeAudioOverflowPolicy = "drop-oldest" | "reject-newest";

export function createGoogleRealtimeAudioQueue(overflowPolicy: GoogleRealtimeAudioOverflowPolicy) {
  let chunks: Buffer[] = [];
  let bytes = 0;

  const clear = () => {
    chunks = [];
    bytes = 0;
  };

  return {
    clear,
    drain: (): Buffer[] => {
      const drained = chunks;
      clear();
      return drained;
    },
    enqueue: (audio: Buffer): boolean => {
      if (audio.byteLength > GOOGLE_REALTIME_MAX_PENDING_AUDIO_BYTES) {
        return false;
      }
      if (
        overflowPolicy === "reject-newest" &&
        (chunks.length >= GOOGLE_REALTIME_MAX_PENDING_AUDIO_CHUNKS ||
          bytes + audio.byteLength > GOOGLE_REALTIME_MAX_PENDING_AUDIO_BYTES)
      ) {
        return false;
      }
      while (
        chunks.length >= GOOGLE_REALTIME_MAX_PENDING_AUDIO_CHUNKS ||
        bytes + audio.byteLength > GOOGLE_REALTIME_MAX_PENDING_AUDIO_BYTES
      ) {
        const dropped = chunks.shift();
        if (!dropped) {
          return false;
        }
        bytes -= dropped.byteLength;
      }
      const chunk = Buffer.from(audio);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      return true;
    },
  };
}
