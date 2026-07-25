// Control UI chat module implements realtime talk audio behavior.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export function floatToG711Ulaw(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const pcm16 = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    let sign = 0;
    let magnitude = pcm16;
    if (magnitude < 0) {
      sign = 0x80;
      magnitude = -magnitude;
    }
    magnitude = Math.min(magnitude, 32635) + 0x84;

    let exponent = 7;
    let mask = 0x4000;
    while ((magnitude & mask) === 0 && exponent > 0) {
      exponent -= 1;
      mask >>= 1;
    }
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    bytes[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return bytes;
}

export type RealtimeTalkAudioFrame = {
  peak: number;
  rms: number;
};

export function measureRealtimeTalkAudioFrame(samples: Float32Array): RealtimeTalkAudioFrame {
  let peak = 0;
  let sumSquares = 0;
  for (const rawSample of samples) {
    const sample = Number.isFinite(rawSample) ? rawSample : 0;
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
  }
  return {
    peak,
    rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0,
  };
}

export class RealtimeTalkPcmInputPump {
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  start(
    media: MediaStream,
    context: AudioContext,
    onSamples: (samples: Float32Array) => void,
  ): void {
    this.stop();
    this.source = context.createMediaStreamSource(media);
    this.processor = context.createScriptProcessor(4096, 1, 1);
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0));
    this.source.connect(this.processor);
    // Keep the processor in the rendered graph without turning capture into a
    // local microphone monitor that can feed speakers back into barge-in.
    this.processor.connect(this.sink);
    this.sink.connect(context.destination);
  }

  stop(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.sink?.disconnect();
    this.sink = null;
    this.source?.disconnect();
    this.source = null;
  }
}

class RealtimeTalkAudioLevelMeter {
  private level = 0;
  private noiseFloor = 0.01;

  sample(samples: Float32Array): number {
    const frame = measureRealtimeTalkAudioFrame(samples);
    const signal = 0.65 * frame.rms + 0.35 * frame.peak;
    if (signal <= Math.max(0.02, this.noiseFloor * 2)) {
      this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * signal;
    }
    const gatedSignal = Math.max(0, signal - this.noiseFloor * 1.5);
    const target = Math.min(1, Math.sqrt(gatedSignal / 0.18));
    const smoothing = target > this.level ? 0.65 : 0.18;
    this.level = smoothing * target + (1 - smoothing) * this.level;
    if (this.level < 0.01) {
      this.level = 0;
    }
    return this.level;
  }

  reset(): void {
    this.level = 0;
    this.noiseFloor = 0.01;
  }
}

export class RealtimeTalkMediaStreamMeter {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private ownsContext = false;
  private readonly levelMeter = new RealtimeTalkAudioLevelMeter();
  private readonly samples = new Float32Array(512);
  private lastLevel = -1;

  constructor(private readonly onLevel: (level: number) => void) {}

  start(media: MediaStream, sharedContext?: AudioContext): void {
    this.stop(false);
    try {
      const context = sharedContext ?? new AudioContext();
      this.context = context;
      this.ownsContext = !sharedContext;
      const source = context.createMediaStreamSource(media);
      this.source = source;
      const analyser = context.createAnalyser();
      this.analyser = analyser;
      analyser.fftSize = this.samples.length;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      this.publishCurrentLevel();
      this.timer = globalThis.setInterval(() => this.publishCurrentLevel(), 100);
    } catch {
      // Metering is feedback only; capture must still work if Web Audio analysis
      // is unavailable in an otherwise functional WebRTC browser.
      this.stop();
    }
  }

  stop(notify = true): void {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer);
      this.timer = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.ownsContext) {
      void this.context?.close();
    }
    this.context = null;
    this.ownsContext = false;
    this.levelMeter.reset();
    this.lastLevel = -1;
    if (notify) {
      this.onLevel(0);
    }
  }

  private publishCurrentLevel(): void {
    if (!this.analyser) {
      return;
    }
    this.samples.fill(0);
    this.analyser.getFloatTimeDomainData(this.samples);
    const level = Math.round(this.levelMeter.sample(this.samples) * 100) / 100;
    if (level === this.lastLevel) {
      return;
    }
    this.lastLevel = level;
    this.onLevel(level);
  }
}

function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

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
