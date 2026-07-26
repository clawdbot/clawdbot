import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

function createTransport(invoke: ReturnType<typeof vi.fn>) {
  return createNodeMeetingRealtimeAudioTransport({
    runtime: { nodes: { invoke } } as never,
    nodeId: "node-1",
    bridgeId: "bridge-1",
    logger: { warn: vi.fn(), debug: vi.fn() } as never,
    commandName: "meeting.chrome",
    logScope: "[meeting]",
    logPrefix: "node",
  });
}

describe("node meeting realtime audio transport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects malformed input and continues with the next valid chunk", async () => {
    vi.useFakeTimers();
    let pullCount = 0;
    let releaseIdlePull: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action !== "pullAudio") {
        releaseIdlePull?.();
        return { ok: true };
      }
      pullCount += 1;
      if (pullCount === 1) {
        return { base64: "not-base64!" };
      }
      if (pullCount === 2) {
        return { base64: Buffer.from([5, 4, 3]).toString("base64") };
      }
      await new Promise<void>((resolve) => {
        releaseIdlePull = resolve;
      });
      return {};
    });
    const transport = createTransport(invoke);
    const onAudio = vi.fn();

    transport.startInput(onAudio);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => {
      expect(onAudio).toHaveBeenCalledWith(Buffer.from([5, 4, 3]));
    });
    expect(transport.getHealth?.()).toEqual({
      consecutiveInputErrors: 0,
      lastInputError: undefined,
      lastOutputLoopbackAt: undefined,
      lastOutputLoopbackCorrelation: undefined,
      lastOutputLoopbackPeak: undefined,
      lastOutputLoopbackRms: undefined,
      outputGeneration: 0,
      outputLoopbackSignalBytes: 0,
      verifiedOutputGeneration: undefined,
    });

    await transport.stop();
  });

  it("signals fatal after five malformed input chunks", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) =>
      params.action === "pullAudio" ? { base64: "not-base64!" } : { ok: true },
    );
    const transport = createTransport(invoke);
    const onFatal = vi.fn();
    const onAudio = vi.fn();
    transport.onFatal(onFatal);

    transport.startInput(onAudio);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledTimes(1);
    });
    expect(onAudio).not.toHaveBeenCalled();
    expect(transport.getHealth?.()).toEqual({
      consecutiveInputErrors: 5,
      lastInputError: "pullAudio base64 must be a valid audio payload",
      lastOutputLoopbackAt: undefined,
      lastOutputLoopbackCorrelation: undefined,
      lastOutputLoopbackPeak: undefined,
      lastOutputLoopbackRms: undefined,
      outputGeneration: 0,
      outputLoopbackSignalBytes: 0,
      verifiedOutputGeneration: undefined,
    });

    await transport.stop();
  });
});
