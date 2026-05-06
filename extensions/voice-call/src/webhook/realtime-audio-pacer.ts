const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.035;
const DEFAULT_REQUIRED_LOUD_CHUNKS = 4;
const DEFAULT_REQUIRED_QUIET_CHUNKS = 12;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const PCM16_MAX_AMPLITUDE = 32768;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);

for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
}

type RealtimeTwilioAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

export type RealtimeTwilioAudioPacerSendJson = (message: unknown) => boolean;

export class RealtimeTwilioAudioPacer {
  private queue: RealtimeTwilioAudioQueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      sendJson: RealtimeTwilioAudioPacerSendJson;
      streamSid: string;
    },
  ) {}

  sendAudio(muLaw: Buffer): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        this.failBackpressure();
        return;
      }
      this.queue.push({
        type: "audio",
        chunk,
        durationMs: Math.max(1, Math.round((chunk.length / TELEPHONY_SAMPLE_RATE) * 1000)),
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
  }

  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
    this.params.sendJson({ event: "clear", streamSid: this.params.streamSid });
    return clearedAudioBytes;
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private ensurePump(): void {
    if (!this.timer) {
      this.pump();
    }
  }

  private failBackpressure(): void {
    this.close();
    this.params.onBackpressure?.();
  }

  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }

    let delayMs = 0;
    let sent = true;
    if (item.type === "audio") {
      this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
      sent = this.params.sendJson({
        event: "media",
        streamSid: this.params.streamSid,
        media: { payload: item.chunk.toString("base64") },
      });
      delayMs = item.durationMs || TELEPHONY_CHUNK_MS;
    } else {
      sent = this.params.sendJson({
        event: "mark",
        streamSid: this.params.streamSid,
        mark: { name: item.name },
      });
    }

    if (!sent) {
      this.queue = [];
      this.queuedAudioBytes = 0;
      return;
    }
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.pump(), delayMs);
    }
  }
}

export function calculateMulawRms(muLaw: Buffer): number {
  if (muLaw.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < muLaw.length; i += 1) {
    const normalized = (MULAW_LINEAR_SAMPLES[muLaw[i] ?? 0] ?? 0) / PCM16_MAX_AMPLITUDE;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / muLaw.length);
}

export class RealtimeMulawSpeechStartDetector {
  private loudChunks = 0;
  private quietChunks = DEFAULT_REQUIRED_QUIET_CHUNKS;
  private speaking = false;

  constructor(
    private readonly params: {
      requiredLoudChunks?: number;
      requiredQuietChunks?: number;
      rmsThreshold?: number;
    } = {},
  ) {}

  accept(muLaw: Buffer): boolean {
    const rms = calculateMulawRms(muLaw);
    const threshold = this.params.rmsThreshold ?? DEFAULT_SPEECH_RMS_THRESHOLD;
    if (rms >= threshold) {
      this.quietChunks = 0;
      this.loudChunks += 1;
      const requiredLoudChunks = this.params.requiredLoudChunks ?? DEFAULT_REQUIRED_LOUD_CHUNKS;
      if (!this.speaking && this.loudChunks >= requiredLoudChunks) {
        this.speaking = true;
        return true;
      }
      return false;
    }

    this.loudChunks = 0;
    this.quietChunks += 1;
    const requiredQuietChunks = this.params.requiredQuietChunks ?? DEFAULT_REQUIRED_QUIET_CHUNKS;
    if (this.quietChunks >= requiredQuietChunks) {
      this.speaking = false;
    }
    return false;
  }
}

function decodeMulawSample(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}
