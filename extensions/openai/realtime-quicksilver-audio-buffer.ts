const RELAY_FRAME_SAMPLES = 480;
const MAX_PENDING_RELAY_FRAMES = 250;

export const OPENAI_QUICKSILVER_RELAY_FRAME_BYTES = RELAY_FRAME_SAMPLES * 2;
// One five-second tail spans peer startup and the connected media pump.
// Keeping the newest PCM bounds latency without changing policy at adoption.
const OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES =
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;

export function appendOpenAIQuicksilverPendingAudio(pending: Buffer, incoming: Buffer): Buffer {
  const evenLength = incoming.length - (incoming.length % 2);
  if (evenLength === 0) {
    return pending;
  }
  const audio = incoming.subarray(0, evenLength);
  if (audio.length >= OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES) {
    return Buffer.from(audio.subarray(audio.length - OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES));
  }
  const pendingBytes = Math.min(
    pending.length,
    OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES - audio.length,
  );
  return Buffer.concat(
    [pending.subarray(pending.length - pendingBytes), audio],
    pendingBytes + audio.length,
  );
}
