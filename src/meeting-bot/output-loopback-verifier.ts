import { mulawToPcm } from "../talk/audio-codec.js";
import { readPcm16AudioStats } from "../talk/audio-energy.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

const OUTPUT_LOOPBACK_OBSERVATION_WINDOW_MS = 5_000;
const OUTPUT_LOOPBACK_REFERENCE_MS = 500;
const OUTPUT_LOOPBACK_INPUT_HISTORY_MS = 10_000;
const OUTPUT_LOOPBACK_FINGERPRINT_POINTS = 64;
const OUTPUT_LOOPBACK_MIN_FINGERPRINT_POINTS = 16;
const OUTPUT_LOOPBACK_FULL_CORRELATION_THRESHOLD = 0.9;
const OUTPUT_LOOPBACK_SHORT_CORRELATION_THRESHOLD = 0.98;
const OUTPUT_LOOPBACK_RMS_THRESHOLD = 8;
const OUTPUT_LOOPBACK_PEAK_THRESHOLD = 32;

type MeetingOutputLoopbackHealth = {
  lastOutputLoopbackAt?: string;
  lastOutputLoopbackCorrelation?: number;
  lastOutputLoopbackPeak?: number;
  lastOutputLoopbackRms?: number;
  outputLoopbackSignalBytes: number;
  outputGeneration: number;
  verifiedOutputGeneration?: number;
};

type OutputFingerprint = {
  offsets: number[];
  referenceMean: number;
  referenceVariance: number;
  samples: number[];
  spanSamples: number;
  threshold: number;
};

function decodeMeetingAudio(audio: Buffer, audioFormat: MeetingRealtimeAudioFormat): Buffer {
  return audioFormat === "g711-ulaw-8khz" ? mulawToPcm(audio) : audio;
}

function hasSignal(stats: { peak: number; rms: number }): boolean {
  return stats.rms >= OUTPUT_LOOPBACK_RMS_THRESHOLD || stats.peak >= OUTPUT_LOOPBACK_PEAK_THRESHOLD;
}

function createOutputFingerprint(
  pcm: Buffer,
  fullReferenceBytes: number,
): OutputFingerprint | undefined {
  const totalSamples = Math.floor(pcm.byteLength * 0.5);
  let firstSignalSample = 0;
  while (
    firstSignalSample < totalSamples &&
    Math.abs(pcm.readInt16LE(firstSignalSample * 2)) < OUTPUT_LOOPBACK_PEAK_THRESHOLD
  ) {
    firstSignalSample += 1;
  }
  let lastSignalSample = totalSamples - 1;
  while (
    lastSignalSample >= firstSignalSample &&
    Math.abs(pcm.readInt16LE(lastSignalSample * 2)) < OUTPUT_LOOPBACK_PEAK_THRESHOLD
  ) {
    lastSignalSample -= 1;
  }
  const activePcm = pcm.subarray(firstSignalSample * 2, (lastSignalSample + 1) * 2);
  const sampleCount = Math.floor(activePcm.byteLength * 0.5);
  const pointCount = Math.min(OUTPUT_LOOPBACK_FINGERPRINT_POINTS, Math.floor(sampleCount * 0.25));
  if (pointCount < OUTPUT_LOOPBACK_MIN_FINGERPRINT_POINTS) {
    return undefined;
  }
  const inversePointCount = pointCount ** -1;
  const selected: Array<{ index: number; sample: number }> = [];
  for (let point = 0; point < pointCount; point += 1) {
    const start = Math.floor(point * sampleCount * inversePointCount);
    const end = Math.max(start + 1, Math.floor((point + 1) * sampleCount * inversePointCount));
    let selectedIndex = start;
    let selectedSample = activePcm.readInt16LE(start * 2);
    for (let index = start + 1; index < end; index += 1) {
      const sample = activePcm.readInt16LE(index * 2);
      if (Math.abs(sample) > Math.abs(selectedSample)) {
        selectedIndex = index;
        selectedSample = sample;
      }
    }
    selected.push({ index: selectedIndex, sample: selectedSample });
  }
  const baseIndex = selected[0]?.index ?? 0;
  const samples = selected.map((entry) => entry.sample);
  const inverseSamples = samples.length ** -1;
  const referenceMean = samples.reduce((sum, sample) => sum + sample, 0) * inverseSamples;
  const referenceVariance = samples.reduce((sum, sample) => {
    const delta = sample - referenceMean;
    return sum + delta * delta;
  }, 0);
  if (referenceVariance === 0) {
    return undefined;
  }
  const offsets = selected.map((entry) => entry.index - baseIndex);
  return {
    offsets,
    referenceMean,
    referenceVariance,
    samples,
    spanSamples: (offsets.at(-1) ?? 0) + 1,
    threshold:
      activePcm.byteLength < fullReferenceBytes
        ? OUTPUT_LOOPBACK_SHORT_CORRELATION_THRESHOLD
        : OUTPUT_LOOPBACK_FULL_CORRELATION_THRESHOLD,
  };
}

function fingerprintCorrelation(pcm: Buffer, startSample: number, fingerprint: OutputFingerprint) {
  let inputSum = 0;
  for (const offset of fingerprint.offsets) {
    inputSum += pcm.readInt16LE((startSample + offset) * 2);
  }
  const inputMean = inputSum * fingerprint.offsets.length ** -1;
  let covariance = 0;
  let inputVariance = 0;
  for (let index = 0; index < fingerprint.offsets.length; index += 1) {
    const referenceDelta = (fingerprint.samples[index] ?? 0) - fingerprint.referenceMean;
    const inputSample = pcm.readInt16LE((startSample + (fingerprint.offsets[index] ?? 0)) * 2);
    const inputDelta = inputSample - inputMean;
    covariance += referenceDelta * inputDelta;
    inputVariance += inputDelta * inputDelta;
  }
  if (inputVariance === 0) {
    return 0;
  }
  return Math.abs(covariance * (fingerprint.referenceVariance * inputVariance) ** -0.5);
}

/** Correlates sink audio with the same waveform returning on the microphone capture path. */
export function createMeetingOutputLoopbackVerifier(options: {
  audioFormat: MeetingRealtimeAudioFormat;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const sampleRate = options.audioFormat === "g711-ulaw-8khz" ? 8_000 : 24_000;
  const fullReferenceBytes = sampleRate * OUTPUT_LOOPBACK_REFERENCE_MS * 0.001 * 2;
  const maxInputHistoryBytes = sampleRate * OUTPUT_LOOPBACK_INPUT_HISTORY_MS * 0.001 * 2;
  let generationStarted = false;
  let generationVerified = false;
  let outputGeneration = 0;
  let verifiedOutputGeneration: number | undefined;
  let inputPcm: Buffer = Buffer.alloc(0);
  let nextInputStartSample = 0;
  let outputFingerprint: OutputFingerprint | undefined;
  let pendingOutputPcm: Buffer = Buffer.alloc(0);
  let outputObservationDeadlineMs = Number.NEGATIVE_INFINITY;
  let outputQueuedUntilMs = Number.NEGATIVE_INFINITY;
  let outputLoopbackSignalBytes = 0;
  let lastOutputLoopbackAt: string | undefined;
  let lastOutputLoopbackCorrelation: number | undefined;
  let lastOutputLoopbackPeak: number | undefined;
  let lastOutputLoopbackRms: number | undefined;

  const resetGeneration = (started: boolean) => {
    generationStarted = started;
    generationVerified = false;
    if (started) {
      outputGeneration += 1;
    }
    inputPcm = Buffer.alloc(0);
    nextInputStartSample = 0;
    outputFingerprint = undefined;
    pendingOutputPcm = Buffer.alloc(0);
    outputObservationDeadlineMs = Number.NEGATIVE_INFINITY;
    outputQueuedUntilMs = Number.NEGATIVE_INFINITY;
  };

  const refreshFingerprint = (fingerprint: OutputFingerprint) => {
    outputFingerprint = fingerprint;
    const inputSampleCount = Math.floor(inputPcm.byteLength * 0.5);
    const rescanTailSamples = sampleRate * OUTPUT_LOOPBACK_REFERENCE_MS * 0.001;
    nextInputStartSample = Math.max(0, inputSampleCount - rescanTailSamples);
  };

  const consumePendingOutput = (allowShortReference: boolean) => {
    const pendingBytes = pendingOutputPcm.byteLength;
    for (let end = pendingBytes; end >= fullReferenceBytes; end -= fullReferenceBytes) {
      const candidate = pendingOutputPcm.subarray(end - fullReferenceBytes, end);
      const fingerprint = createOutputFingerprint(candidate, fullReferenceBytes);
      if (fingerprint) {
        pendingOutputPcm = Buffer.alloc(0);
        refreshFingerprint(fingerprint);
        return;
      }
    }
    const residualBytes = pendingBytes % fullReferenceBytes;
    if (residualBytes > 0) {
      const residual = pendingOutputPcm.subarray(0, residualBytes);
      const fingerprint = createOutputFingerprint(residual, fullReferenceBytes);
      if (fingerprint) {
        pendingOutputPcm = Buffer.alloc(0);
        refreshFingerprint(fingerprint);
        return;
      }
    }
    pendingOutputPcm =
      pendingBytes > fullReferenceBytes
        ? pendingOutputPcm.subarray(pendingBytes - fullReferenceBytes)
        : pendingOutputPcm;
    if (!outputFingerprint && allowShortReference && pendingOutputPcm.byteLength > 0) {
      const fingerprint = createOutputFingerprint(pendingOutputPcm, fullReferenceBytes);
      if (fingerprint) {
        pendingOutputPcm = Buffer.alloc(0);
        refreshFingerprint(fingerprint);
      }
    }
  };

  return {
    beginOutput(): void {
      resetGeneration(true);
    },
    cancelOutput(): void {
      resetGeneration(false);
    },
    recordInput(audio: Buffer): void {
      const capturedAtMs = now();
      if (
        !generationStarted ||
        generationVerified ||
        audio.byteLength === 0 ||
        capturedAtMs > outputObservationDeadlineMs
      ) {
        return;
      }
      const decoded = decodeMeetingAudio(audio, options.audioFormat);
      const chunkStats = readPcm16AudioStats(decoded);
      const combinedInput = inputPcm.byteLength > 0 ? Buffer.concat([inputPcm, decoded]) : decoded;
      const droppedInputBytes = Math.max(0, combinedInput.byteLength - maxInputHistoryBytes);
      inputPcm = droppedInputBytes > 0 ? combinedInput.subarray(droppedInputBytes) : combinedInput;
      if (droppedInputBytes > 0) {
        nextInputStartSample = Math.max(
          0,
          nextInputStartSample - Math.floor(droppedInputBytes * 0.5),
        );
      }
      const fingerprint = outputFingerprint;
      if (!fingerprint || !hasSignal(chunkStats)) {
        return;
      }
      const inputSampleCount = Math.floor(inputPcm.byteLength * 0.5);
      const lastStartSample = inputSampleCount - fingerprint.spanSamples;
      for (
        let startSample = nextInputStartSample;
        startSample <= lastStartSample;
        startSample += 1
      ) {
        const matchedCorrelation = fingerprintCorrelation(inputPcm, startSample, fingerprint);
        if (matchedCorrelation < fingerprint.threshold) {
          continue;
        }
        const matchedPcm = inputPcm.subarray(
          startSample * 2,
          (startSample + fingerprint.spanSamples) * 2,
        );
        const matchedStats = readPcm16AudioStats(matchedPcm);
        if (!hasSignal(matchedStats)) {
          continue;
        }
        generationVerified = true;
        verifiedOutputGeneration = outputGeneration;
        outputLoopbackSignalBytes += audio.byteLength;
        lastOutputLoopbackAt = new Date(capturedAtMs).toISOString();
        lastOutputLoopbackCorrelation = matchedCorrelation;
        lastOutputLoopbackPeak = matchedStats.peak;
        lastOutputLoopbackRms = matchedStats.rms;
        return;
      }
      nextInputStartSample = Math.max(0, lastStartSample + 1);
    },
    recordOutput(audio: Buffer): void {
      const outputAtMs = now();
      if (
        !generationStarted ||
        (outputObservationDeadlineMs !== Number.NEGATIVE_INFINITY &&
          outputAtMs > outputObservationDeadlineMs)
      ) {
        resetGeneration(true);
      }
      if (audio.byteLength === 0) {
        return;
      }
      const decoded = decodeMeetingAudio(audio, options.audioFormat);
      const durationMs = decoded.byteLength * 0.5 * sampleRate ** -1 * 1_000;
      outputQueuedUntilMs = Math.max(outputAtMs, outputQueuedUntilMs) + durationMs;
      pendingOutputPcm = Buffer.concat([pendingOutputPcm, decoded]);
      if (!outputFingerprint) {
        consumePendingOutput(true);
      } else if (pendingOutputPcm.byteLength >= fullReferenceBytes) {
        consumePendingOutput(false);
      }
      outputObservationDeadlineMs = Math.max(
        outputObservationDeadlineMs,
        outputQueuedUntilMs + OUTPUT_LOOPBACK_OBSERVATION_WINDOW_MS,
      );
    },
    getHealth(): MeetingOutputLoopbackHealth {
      return {
        lastOutputLoopbackAt,
        lastOutputLoopbackCorrelation,
        lastOutputLoopbackPeak,
        lastOutputLoopbackRms,
        outputLoopbackSignalBytes,
        outputGeneration,
        verifiedOutputGeneration,
      };
    },
  };
}
