// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureRealtimeTalkAudioFrame,
  RealtimeTalkAudioLevelMeter,
  RealtimeTalkMediaStreamMeter,
} from "./realtime-talk-audio.ts";

describe("RealtimeTalkAudioLevelMeter", () => {
  it("keeps silence flat and makes louder speech more visible", () => {
    const silentFrame = measureRealtimeTalkAudioFrame(new Float32Array(512));
    const silent = new RealtimeTalkAudioLevelMeter().sample(new Float32Array(512));
    const quiet = new RealtimeTalkAudioLevelMeter().sample(new Float32Array(512).fill(0.03));
    const loud = new RealtimeTalkAudioLevelMeter().sample(new Float32Array(512).fill(0.25));

    expect(silentFrame).toEqual({ peak: 0, rms: 0 });
    expect(silent).toBe(0);
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });

  it("ignores invalid samples and releases smoothly after speech", () => {
    const meter = new RealtimeTalkAudioLevelMeter();
    const invalid = meter.sample(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]));
    const speech = meter.sample(new Float32Array(512).fill(0.4));
    const firstSilence = meter.sample(new Float32Array(512));
    let settled = firstSilence;
    for (let index = 0; index < 12; index += 1) {
      settled = meter.sample(new Float32Array(512));
    }

    expect(invalid).toBe(0);
    expect(firstSilence).toBeLessThan(speech);
    expect(firstSilence).toBeGreaterThan(0);
    expect(settled).toBeLessThan(firstSilence);
  });

  it("settles steady room noise while keeping a speech burst visible", () => {
    const meter = new RealtimeTalkAudioLevelMeter();
    let noiseLevel = 0;
    for (let index = 0; index < 80; index += 1) {
      noiseLevel = meter.sample(new Float32Array(512).fill(0.015));
    }
    const speechLevel = meter.sample(new Float32Array(512).fill(0.2));

    expect(noiseLevel).toBeLessThan(0.08);
    expect(speechLevel).toBeGreaterThan(0.5);
  });
});

describe("RealtimeTalkMediaStreamMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("samples a WebRTC input stream and resets its level when stopped", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const disconnectSource = vi.fn();
    const disconnectAnalyser = vi.fn();
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect: disconnectAnalyser,
      getFloatTimeDomainData: vi
        .fn()
        .mockImplementationOnce((samples: Float32Array) => samples.fill(0.2))
        .mockImplementation((samples: Float32Array) => samples.fill(0)),
    };
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: disconnectSource };
      }
      createAnalyser() {
        return analyser;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();
    const meter = new RealtimeTalkMediaStreamMeter(onLevel);

    meter.start({} as MediaStream);
    vi.advanceTimersByTime(3_000);

    expect(onLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    meter.stop();

    expect(analyser.fftSize).toBe(512);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an owned AudioContext when analyser setup fails", () => {
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        throw new Error("source unavailable");
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();

    new RealtimeTalkMediaStreamMeter(onLevel).start({} as MediaStream);

    expect(close).toHaveBeenCalledOnce();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });
});
