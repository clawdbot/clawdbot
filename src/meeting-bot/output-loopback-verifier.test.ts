import { describe, expect, it } from "vitest";
import { createMeetingOutputLoopbackVerifier } from "./output-loopback-verifier.js";

function pcmEnergyFrames(amplitudes: readonly number[]): Buffer {
  const samplesPerFrame = 240;
  const audio = Buffer.alloc(amplitudes.length * samplesPerFrame * 2);
  amplitudes.forEach((amplitude, frameIndex) => {
    const roundedAmplitude = Math.round(amplitude);
    for (let sampleIndex = 0; sampleIndex < samplesPerFrame; sampleIndex += 1) {
      const sample = sampleIndex % 2 === 0 ? roundedAmplitude : -roundedAmplitude;
      audio.writeInt16LE(sample, (frameIndex * samplesPerFrame + sampleIndex) * 2);
    }
  });
  return audio;
}

const outputEnvelope = Array.from({ length: 80 }, (_, index) => 400 + ((index * 7919) % 12_000));
const unrelatedEnvelope = Array.from(
  { length: 80 },
  (_, index) => 500 + ((index * 3571 + 1_231) % 9_000),
);

describe("meeting output loopback verifier", () => {
  it("requires the current output energy envelope on the captured input", () => {
    let nowMs = 1_000;
    const verifier = createMeetingOutputLoopbackVerifier({
      audioFormat: "pcm16-24khz",
      now: () => nowMs,
    });

    verifier.recordInput(pcmEnergyFrames(outputEnvelope));
    verifier.recordOutput(pcmEnergyFrames(Array(80).fill(0)));
    verifier.recordInput(pcmEnergyFrames(outputEnvelope));
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    verifier.beginOutput();
    verifier.recordOutput(pcmEnergyFrames(outputEnvelope));
    verifier.recordInput(pcmEnergyFrames(unrelatedEnvelope));
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    nowMs = 1_100;
    const captured = pcmEnergyFrames(outputEnvelope.map((amplitude) => amplitude * 0.5));
    verifier.recordInput(captured);
    const health = verifier.getHealth();
    expect(health.lastOutputLoopbackAt).toBe("1970-01-01T00:00:01.100Z");
    expect(health.lastOutputLoopbackCorrelation).toBeGreaterThanOrEqual(0.9);
    expect(health.outputLoopbackSignalBytes).toBe(captured.byteLength);
    expect(health.verifiedOutputGeneration).toBe(health.outputGeneration);
  });

  it("does not reuse a matching capture from an older output generation", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const first = pcmEnergyFrames(outputEnvelope);
    const second = pcmEnergyFrames(unrelatedEnvelope);
    verifier.beginOutput();
    verifier.recordOutput(first);
    verifier.recordInput(first);
    const verifiedBytes = verifier.getHealth().outputLoopbackSignalBytes;

    verifier.beginOutput();
    verifier.recordOutput(second);
    expect(verifier.getHealth().verifiedOutputGeneration).not.toBe(
      verifier.getHealth().outputGeneration,
    );
    verifier.recordInput(first);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(verifiedBytes);

    verifier.recordInput(second);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBeGreaterThan(verifiedBytes);
  });

  it("uses a stricter full-envelope match for short output generations", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const shortOutput = pcmEnergyFrames(outputEnvelope.slice(0, 20));
    const unrelated = pcmEnergyFrames(unrelatedEnvelope.slice(0, 20));

    verifier.beginOutput();
    verifier.recordOutput(shortOutput);
    verifier.recordInput(unrelated);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    verifier.recordInput(shortOutput);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(shortOutput.byteLength);
    expect(verifier.getHealth().lastOutputLoopbackCorrelation).toBeGreaterThanOrEqual(0.98);
  });

  it("finds a short loopback envelope between capture pre-roll and post-roll", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const shortEnvelope = outputEnvelope.slice(0, 20);
    const captureEnvelope = [
      ...unrelatedEnvelope.slice(0, 5),
      ...shortEnvelope,
      ...unrelatedEnvelope.slice(5, 10),
    ];

    verifier.beginOutput();
    verifier.recordOutput(pcmEnergyFrames(shortEnvelope));
    const capture = pcmEnergyFrames(captureEnvelope);
    verifier.recordInput(capture);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(capture.byteLength);
  });

  it("matches loopback delayed by a sub-frame sample offset", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const output = pcmEnergyFrames(outputEnvelope.slice(0, 30));
    const fiveMsPreRoll = Buffer.alloc(120 * 2);
    const capture = Buffer.concat([fiveMsPreRoll, output]);

    verifier.beginOutput();
    verifier.recordOutput(output);
    verifier.recordInput(capture);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(capture.byteLength);
  });

  it("skips a silent leading reference window in a mixed output buffer", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const silence = pcmEnergyFrames(Array(60).fill(0));
    const signal = pcmEnergyFrames(outputEnvelope.slice(0, 20));

    verifier.beginOutput();
    verifier.recordOutput(Buffer.concat([silence, signal]));
    verifier.recordInput(signal);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(signal.byteLength);
  });

  it("rejects a correlated waveform below the signal threshold", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const output = pcmEnergyFrames(outputEnvelope.slice(0, 20));
    const attenuated = pcmEnergyFrames(
      outputEnvelope.slice(0, 20).map((amplitude) => amplitude * 0.0005),
    );
    const unrelatedLoudAudio = pcmEnergyFrames(unrelatedEnvelope.slice(0, 20));

    verifier.beginOutput();
    verifier.recordOutput(output);
    verifier.recordInput(Buffer.concat([attenuated, unrelatedLoudAudio]));

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);
  });

  it("rejects unrelated input after the correlation window", () => {
    let nowMs = 0;
    const verifier = createMeetingOutputLoopbackVerifier({
      audioFormat: "pcm16-24khz",
      now: () => nowMs,
    });
    verifier.beginOutput();
    verifier.recordOutput(pcmEnergyFrames(outputEnvelope));
    nowMs = 5_801;
    verifier.recordInput(pcmEnergyFrames(outputEnvelope));

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);
  });

  it("keeps the most recent reference frames for long output generations", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const longEnvelope = Array.from({ length: 600 }, (_, index) => 300 + ((index * 6151) % 11_000));
    const recentOutput = pcmEnergyFrames(longEnvelope.slice(-80));

    verifier.beginOutput();
    verifier.recordOutput(pcmEnergyFrames(longEnvelope.slice(0, 520)));
    verifier.recordOutput(pcmEnergyFrames(longEnvelope.slice(520)));
    verifier.recordInput(recentOutput);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(recentOutput.byteLength);
  });

  it("uses a bounded recent reference from one long output buffer", () => {
    let nowMs = 0;
    const verifier = createMeetingOutputLoopbackVerifier({
      audioFormat: "pcm16-24khz",
      now: () => nowMs,
    });
    const longOutput = pcmEnergyFrames(
      Array.from({ length: 600 }, (_, index) => 400 + ((index * 4561) % 10_000)),
    );
    const recentOutput = longOutput.subarray(longOutput.byteLength - 48_000);

    verifier.beginOutput();
    verifier.recordOutput(longOutput);
    nowMs = 6_000;
    verifier.recordInput(recentOutput);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(recentOutput.byteLength);
  });

  it("preserves silent spacing between streamed output chunks", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const first = pcmEnergyFrames(outputEnvelope.slice(0, 30));
    const silence = pcmEnergyFrames(Array(30).fill(0));
    const second = pcmEnergyFrames(outputEnvelope.slice(30, 60));
    const expectedRecentReference = Buffer.concat([silence.subarray(4_800), second]);

    verifier.beginOutput();
    verifier.recordOutput(first);
    verifier.recordOutput(silence);
    verifier.recordOutput(second);
    verifier.recordInput(expectedRecentReference);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(expectedRecentReference.byteLength);
  });

  it("checks a signal prefix shorter than a full trailing-silence window", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz" });
    const signal = pcmEnergyFrames(outputEnvelope.slice(0, 10));
    const trailingSilence = pcmEnergyFrames(Array(50).fill(0));

    verifier.beginOutput();
    verifier.recordOutput(Buffer.concat([signal, trailingSilence]));
    verifier.recordInput(signal);

    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(signal.byteLength);
  });

  it("detects mu-law loopback energy without treating silence as signal", () => {
    const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "g711-ulaw-8khz" });
    const silence = Buffer.alloc(80 * 80, 0xff);
    const signal = Buffer.concat(
      Array.from({ length: 80 }, (_, index) => Buffer.alloc(80, (index * 37) % 220)),
    );
    verifier.beginOutput();
    verifier.recordOutput(silence);
    verifier.recordInput(signal);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    verifier.beginOutput();
    verifier.recordOutput(signal);
    verifier.recordInput(signal);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(signal.byteLength);
    expect(verifier.getHealth().lastOutputLoopbackPeak).toBeGreaterThan(0);
  });
});
