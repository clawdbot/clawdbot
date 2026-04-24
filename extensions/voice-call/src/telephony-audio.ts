export {
  convertPcmToMulaw8k,
  pcmToMulaw,
  resamplePcmTo8k,
} from "openclaw/plugin-sdk/realtime-voice";

/**
 * Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
