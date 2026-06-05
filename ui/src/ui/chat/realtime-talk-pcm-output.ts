// Control UI chat module implements realtime talk pcm output behavior.
import { base64ToBytes, pcm16ToFloat } from "./realtime-talk-audio.ts";

export class RealtimeTalkPcmOutputQueue {
  private playhead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  get queuedUntil(): number {
    return this.playhead;
  }

  get isPlaying(): boolean {
    return this.sources.size > 0;
  }

  play(base64: string, outputContext: AudioContext | null, outputSampleRateHz: number): void {
    if (!outputContext) {
      return;
    }
    const samples = pcm16ToFloat(base64ToBytes(base64));
    if (samples.length === 0) {
      return;
    }
    const buffer = outputContext.createBuffer(1, samples.length, outputSampleRateHz);
    buffer.getChannelData(0).set(samples);
    const source = outputContext.createBufferSource();
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source));
    source.buffer = buffer;
    source.connect(outputContext.destination);
    const startAt = Math.max(outputContext.currentTime, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
  }

  stop(outputContext: AudioContext | null): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.playhead = outputContext?.currentTime ?? 0;
  }
}
