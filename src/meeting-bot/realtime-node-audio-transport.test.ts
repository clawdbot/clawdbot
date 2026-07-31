import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

function createTransport(
  invoke: ReturnType<typeof vi.fn>,
  options: { outputGenerationSupported?: boolean } = {},
) {
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: { nodes: { invoke } } as never,
    nodeId: "node-1",
    bridgeId: "bridge-1",
    logger: { warn: vi.fn(), debug: vi.fn() } as never,
    commandName: "meeting.chrome",
    logScope: "[meeting]",
    logPrefix: "node",
  });
  Reflect.set(
    transport,
    Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
    options.outputGenerationSupported === true,
  );
  return transport;
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

  it("fences output writes across clear and stop", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const transport = createTransport(invoke, { outputGenerationSupported: true });

    await transport.writeOutput(Buffer.from([1, 2, 3]));
    await transport.clearOutput();
    await transport.writeOutput(Buffer.from([4, 5, 6]));

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: expect.objectContaining({
          action: "pushAudio",
          outputGeneration: 0,
        }),
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
          outputGeneration: 1,
        },
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        params: expect.objectContaining({
          action: "pushAudio",
          outputGeneration: 1,
        }),
      }),
    );

    await transport.stop();
    const invokeCountAfterStop = invoke.mock.calls.length;
    await transport.writeOutput(Buffer.from([7, 8, 9]));
    await transport.clearOutput();
    expect(invoke).toHaveBeenCalledTimes(invokeCountAfterStop);
  });

  it("serializes output commands for legacy node hosts", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: {
          action: "pushAudio",
          bridgeId: "bridge-1",
          base64: Buffer.from([1, 2, 3]).toString("base64"),
        },
      }),
    );

    releasePush?.();
    await Promise.all([pushing, clearing]);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
        },
      }),
    );

    await transport.stop();
  });

  it("clears immediately when the node host supports output generations", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke, { outputGenerationSupported: true });

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    await transport.clearOutput();
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
          outputGeneration: 1,
        },
      }),
    );

    releasePush?.();
    await pushing;
    await transport.stop();
  });

  it("stops a legacy node host without waiting for blocked output", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      } else if (params.action === "stop") {
        releasePush?.();
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    await transport.stop();
    await Promise.all([pushing, clearing]);

    expect(invoke.mock.calls.map(([call]) => call.params.action)).toEqual(["pushAudio", "stop"]);
  });
});
