// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkMediaStreamMeter } from "./realtime-talk-audio.ts";

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
