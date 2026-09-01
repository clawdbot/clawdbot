// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { prepareRealtimeTalkTestInput } from "./realtime-talk-input.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeTalkEvent,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type GatewayFrame = { event: string; payload?: unknown };
type GatewayListener = (event: GatewayFrame) => void;
type MockProcessor = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
    | null;
};

const listeners = new Set<GatewayListener>();
const processors: MockProcessor[] = [];
const inputSinks: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: { value: number };
}> = [];
const createdSources: MockAudioBufferSource[] = [];
let getUserMedia: ReturnType<typeof vi.fn>;
let audioCurrentTime = 0;

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

class MockAudioContext {
  get currentTime(): number {
    return audioCurrentTime;
  }
  readonly destination = {};
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    const processor: MockProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  }

  createGain() {
    const sink = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1 },
    };
    inputSinks.push(sink);
    return sink;
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    };
  }

  createBufferSource() {
    const source = new MockAudioBufferSource();
    createdSources.push(source);
    return source;
  }
}

function createSession(): RealtimeTalkGatewayRelaySessionResult {
  return {
    provider: "openai",
    transport: "gateway-relay",
    relaySessionId: "relay-1",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

function createClient(): RealtimeTalkTransportContext["client"] {
  return {
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request: vi.fn(async () => ({})),
  } as unknown as RealtimeTalkTransportContext["client"];
}

async function createTransport(overrides: Partial<RealtimeTalkTransportContext> = {}) {
  return new GatewayRelayRealtimeTalkTransport(createSession(), {
    input: await prepareRealtimeTalkTestInput(),
    callbacks: {},
    client: createClient(),
    sessionKey: "main",
    ...overrides,
  });
}

async function startTransport(transport: GatewayRelayRealtimeTalkTransport): Promise<void> {
  await expect(transport.start()).resolves.toBe("ready");
  transport.activate();
}

function emitGatewayFrame(frame: GatewayFrame): void {
  for (const listener of listeners) {
    listener(frame);
  }
}

function emitTalkEvent(payload: unknown): void {
  let eventPayload = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const event = payload as Record<string, unknown>;
    if ((event.type === "audio" || event.type === "clear") && event.talkEvent === undefined) {
      eventPayload = { ...event, talkEvent: { turnId: "turn-1" } };
    }
  }
  emitGatewayFrame({ event: "talk.event", payload: eventPayload });
}

function pumpMicrophone(samples: Float32Array): void {
  const processor = processors.at(-1);
  if (!processor) {
    throw new Error("Expected microphone script processor to be created");
  }
  processor.onaudioprocess?.({
    inputBuffer: {
      getChannelData: () => samples,
    },
  });
}

function zeroPcmBase64(sampleRate: number): string {
  return "AAAA".repeat((sampleRate * 2) / 3);
}

function requestCallsFor(
  client: RealtimeTalkTransportContext["client"],
  method: string,
): Array<Parameters<RealtimeTalkTransportContext["client"]["request"]>> {
  return vi.mocked(client["request"]).mock.calls.filter((call) => call[0] === method);
}

describe("GatewayRelayRealtimeTalkTransport", () => {
  beforeEach(() => {
    listeners.clear();
    processors.length = 0;
    inputSinks.length = 0;
    createdSources.length = 0;
    audioCurrentTime = 0;
    vi.stubGlobal("AudioContext", MockAudioContext);
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [Object.assign(new EventTarget(), { stop: vi.fn() })],
    }));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    listeners.clear();
    processors.length = 0;
    inputSinks.length = 0;
    createdSources.length = 0;
  });

  it("closes relay resources on microphone loss even when status delivery throws", async () => {
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const addListener = vi.spyOn(track, "addEventListener");
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    const client = createClient();
    const onStatus = vi.fn();
    const transport = await createTransport({ client, callbacks: { onStatus } });
    await startTransport(transport);
    onStatus.mockImplementation(() => {
      throw new Error("status failed");
    });

    const ended = addListener.mock.calls[0]?.[1];
    expect(() => {
      if (typeof ended === "function") {
        ended(new Event("ended"));
      }
    }).toThrow("status failed");
    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("Microphone"));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(processors[0]?.onaudioprocess).toBeNull();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    transport.stop();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("keeps the microphone processor inaudible locally", async () => {
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      input: await prepareRealtimeTalkTestInput(),
      callbacks: {},
      client: createClient(),
      sessionKey: "main",
    });

    await startTransport(transport);

    const processor = processors.at(-1);
    const sink = inputSinks.at(-1);
    if (!processor || !sink) {
      throw new Error("missing microphone capture graph");
    }
    expect(sink.gain.value).toBe(0);
    expect(processor.connect).toHaveBeenCalledWith(sink);
    expect(sink.connect).toHaveBeenCalledOnce();

    transport.stop();
    expect(sink.disconnect).toHaveBeenCalledOnce();
  });

  it("defers relay effects until the transport is committed", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const transport = await createTransport({
      client,
      callbacks: { onStatus, onTranscript },
    });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "transcript",
      role: "assistant",
      text: "not committed yet",
      final: true,
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: "unknown_tool",
      args: {},
    });

    expect(onStatus).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    transport.activate();

    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onTranscript).toHaveBeenCalledWith({
      role: "assistant",
      text: "not committed yet",
      final: true,
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    transport.stop();
  });

  it("fails a provisional relay whose bounded event buffer overflows", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    for (let index = 0; index < 33; index += 1) {
      emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
    }
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);

    expect(() => transport.activate()).toThrow(
      "Realtime relay emitted too much data before browser setup completed",
    );
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("enforces the provisional relay byte bound", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await expect(transport.start()).resolves.toBe("ready");
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "transcript",
      role: "assistant",
      text: "x".repeat(131_073),
      final: true,
    });

    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    expect(() => transport.activate()).toThrow(
      "Realtime relay emitted too much data before browser setup completed",
    );
  });

  it("rejects a relay that closes before browser setup commits", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "error",
      message: "provider rejected setup",
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "close",
      reason: "error",
    });

    expect(() => transport.activate()).toThrow("provider rejected setup");
    expect(onStatus).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
  });

  it("closes the relay when a provisional callback throws during activation", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    const start = transport.start();
    emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
    await expect(start).resolves.toBe("ready");
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });

    expect(() => transport.activate()).toThrow("consumer failed");
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("forwards common Talk events from Gateway relay frames", async () => {
    const onTalkEvent = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      input: await prepareRealtimeTalkTestInput(),
      callbacks: { onTalkEvent },
      client: createClient(),
      sessionKey: "main",
    });
    const talkEvent = {
      id: "relay-1:1",
      type: "session.ready",
      sessionId: "relay-1",
      seq: 1,
      timestamp: "2026-05-05T00:00:00.000Z",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      payload: {},
    } satisfies RealtimeTalkEvent;

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "ready",
      talkEvent,
    });

    expect(onTalkEvent).toHaveBeenCalledWith(talkEvent);
    transport.stop();
  });

  it("does not forward Talk events for another relay session", async () => {
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ callbacks: { onTalkEvent } });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-other",
      type: "ready",
      talkEvent: {
        id: "relay-other:1",
        type: "session.ready",
        sessionId: "relay-other",
        seq: 1,
        timestamp: "2026-05-05T00:00:00.000Z",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        payload: {},
      } satisfies RealtimeTalkEvent,
    });

    expect(onTalkEvent).not.toHaveBeenCalled();
    transport.stop();
  });

  it("keeps assistant playback alive while relay input is silence", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: "AAAA",
    });
    pumpMicrophone(new Float32Array(4096));

    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
    const appendCall = vi
      .mocked(client["request"])
      .mock.calls.find((call) => call[0] === "talk.session.appendAudio");
    expect((appendCall?.[1] as { sessionId?: string } | undefined)?.sessionId).toBe("relay-1");
    transport.stop();
  });

  it("cancels overflowing playback and ignores late audio until provider clear", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    for (let index = 0; index < 321; index += 1) {
      emitTalkEvent({
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: "AAAA",
      });
    }

    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([
        [
          "talk.session.cancelOutput",
          {
            sessionId: "relay-1",
            reason: "playback-overflow",
            turnId: "turn-1",
          },
        ],
      ]),
    );
    expect(createdSources).toHaveLength(320);
    expect(createdSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);

    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: "AAAA",
    });
    expect(createdSources).toHaveLength(320);

    emitTalkEvent({ relaySessionId: "relay-1", type: "clear" });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: "AAAA",
    });
    expect(createdSources).toHaveLength(321);
    expect(createdSources.at(-1)?.start).toHaveBeenCalledOnce();

    transport.stop();
  });

  it("cancels provider output when the first audio chunk exceeds the time budget", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000 * 11),
    });

    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([
        [
          "talk.session.cancelOutput",
          {
            sessionId: "relay-1",
            reason: "playback-overflow",
            turnId: "turn-1",
          },
        ],
      ]),
    );
    expect(createdSources).toHaveLength(0);

    transport.stop();
  });

  it("acknowledges provider marks only after the local playback queue drains", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({ relaySessionId: "relay-1", type: "mark", markName: "mark-1" });

    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
    audioCurrentTime = 1;
    await vi.advanceTimersByTimeAsync(1000);

    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toEqual([
      ["talk.session.acknowledgeMark", { sessionId: "relay-1", markName: "mark-1" }],
    ]);
    transport.stop();
  });

  it("clears pending provider mark timers when stopped", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({ relaySessionId: "relay-1", type: "mark", markName: "mark-1" });

    expect(vi.getTimerCount()).toBe(1);
    transport.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
  });

  it("reports microphone activity and resets it when stopped", async () => {
    const onInputLevel = vi.fn();
    const transport = await createTransport({ callbacks: { onInputLevel } });

    await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096).fill(0.25));
    transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

  it("reclaims the input meter when its first level update stops the transport", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const onInputLevel = vi.fn((level: number) => {
      if (level > 0) {
        transport.stop();
      }
    });
    const transport = await createTransport({ client, callbacks: { onInputLevel } });

    await expect(transport.start()).resolves.toBe("ready");
    transport.stop();
    transport.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("fails visibly when stalled microphone appends reach the ownership cap", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    let activeAppends = 0;
    let peakActiveAppends = 0;
    const appendSignals: AbortSignal[] = [];
    vi.mocked(client["request"]).mockImplementation((method, _params, options) => {
      if (method !== "talk.session.appendAudio") {
        return Promise.resolve({});
      }
      const signal = options?.signal;
      if (!signal) {
        return Promise.reject(new Error("missing append abort signal"));
      }
      appendSignals.push(signal);
      activeAppends += 1;
      peakActiveAppends = Math.max(peakActiveAppends, activeAppends);
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            activeAppends -= 1;
            reject(new Error("append aborted"));
          },
          { once: true },
        );
      });
    });
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    const samples = new Float32Array(4096);
    for (let index = 0; index < 10_000; index += 1) {
      pumpMicrophone(samples);
    }

    const appendCalls = requestCallsFor(client, "talk.session.appendAudio");
    expect(appendCalls).toHaveLength(4);
    expect(peakActiveAppends).toBe(4);
    expect(new Set(appendSignals).size).toBe(1);
    expect(
      appendCalls.every(
        (call) => call[2]?.signal === appendSignals[0] && call[2]?.timeoutMs === 8_000,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(activeAppends).toBe(0);
    expect(appendSignals.every((signal) => signal.aborted)).toBe(true);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime Talk audio input fell behind");

    transport.stop();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("preserves accepted microphone frame order", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await startTransport(transport);
    for (const timestamp of [10, 20, 30, 40]) {
      audioCurrentTime = timestamp / 1_000;
      pumpMicrophone(new Float32Array(4096));
    }

    expect(
      requestCallsFor(client, "talk.session.appendAudio").map(
        (call) => (call[1] as { timestamp: number }).timestamp,
      ),
    ).toEqual([10, 20, 30, 40]);
    transport.stop();
  });

  it("ignores a stale append rejection after a replacement starts", async () => {
    const oldStatus = vi.fn();
    const oldClient = createClient();
    let rejectOldAppend: (error: Error) => void = () => undefined;
    vi.mocked(oldClient["request"]).mockImplementation((method) => {
      if (method !== "talk.session.appendAudio") {
        return Promise.resolve({});
      }
      return new Promise((_, reject) => {
        rejectOldAppend = reject;
      });
    });
    const oldTransport = await createTransport({
      callbacks: { onStatus: oldStatus },
      client: oldClient,
    });

    await oldTransport.start();
    oldStatus.mockClear();
    pumpMicrophone(new Float32Array(4096));
    oldTransport.stop();

    const replacementStatus = vi.fn();
    const replacementClient = createClient();
    const replacement = await createTransport({
      callbacks: { onStatus: replacementStatus },
      client: replacementClient,
    });
    await replacement.start();
    replacementStatus.mockClear();
    pumpMicrophone(new Float32Array(4096));
    rejectOldAppend(new Error("late stale append failure"));
    await Promise.resolve();

    expect(requestCallsFor(replacementClient, "talk.session.appendAudio")).toHaveLength(1);
    expect(oldStatus).not.toHaveBeenCalled();
    expect(replacementStatus).not.toHaveBeenCalled();
    replacement.stop();
  });

  it("stops microphone pumping when the relay rejects appended audio", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.session.appendAudio") {
        throw new Error("Unknown realtime relay session");
      }
      return {};
    });
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Unknown realtime relay session"),
    );
    pumpMicrophone(new Float32Array(4096));
    transport.stop();

    const appendCalls = vi
      .mocked(client["request"])
      .mock.calls.filter(([method]) => method === "talk.session.appendAudio");
    const closeCalls = vi
      .mocked(client["request"])
      .mock.calls.filter(([method]) => method === "talk.session.close");
    expect(appendCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.[1]).toEqual({ sessionId: "relay-1" });
  });

  it("treats relay close events as local shutdown", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "close",
      reason: "error",
    });
    pumpMicrophone(new Float32Array(4096));
    transport.stop();

    const appendCalls = vi
      .mocked(client["request"])
      .mock.calls.filter(([method]) => method === "talk.session.appendAudio");
    const closeCalls = vi
      .mocked(client["request"])
      .mock.calls.filter(([method]) => method === "talk.session.close");
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime relay closed");
    expect(appendCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(0);
  });

  it.each(["talk event", "status"] as const)(
    "releases local resources when a close %s callback throws",
    async (callbackKind) => {
      const stopTrack = vi.fn();
      getUserMedia.mockResolvedValue({
        getTracks: () => [Object.assign(new EventTarget(), { stop: stopTrack })],
      } as unknown as MediaStream);
      const throwingCallback = vi.fn();
      const client = createClient();
      const transport = await createTransport({
        client,
        callbacks:
          callbackKind === "talk event"
            ? { onTalkEvent: throwingCallback }
            : { onStatus: throwingCallback },
      });

      await startTransport(transport);
      throwingCallback.mockImplementation(() => {
        throw new Error("consumer failed");
      });
      expect(() =>
        emitTalkEvent({
          relaySessionId: "relay-1",
          type: "close",
          reason: "error",
          talkEvent:
            callbackKind === "talk event"
              ? ({
                  id: "relay-1:1",
                  type: "session.closed",
                  sessionId: "relay-1",
                  seq: 1,
                  timestamp: "2026-05-05T00:00:00.000Z",
                  mode: "realtime",
                  transport: "gateway-relay",
                  brain: "agent-consult",
                  payload: {},
                  final: true,
                } satisfies RealtimeTalkEvent)
              : undefined,
        }),
      ).toThrow("consumer failed");

      expect(stopTrack).toHaveBeenCalledOnce();
      expect(processors.at(-1)?.disconnect).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
      emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
      transport.stop();
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    },
  );

  it("preserves relay error details across close events", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "error",
      message: "API version mismatch",
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "close",
      reason: "error",
    });

    expect(onStatus).toHaveBeenCalledWith("error", "API version mismatch");
    expect(onStatus).toHaveBeenLastCalledWith("error", "API version mismatch");
  });

  it("cancels relay playback after sustained input speech", async () => {
    const client = createClient();
    const transport = await createTransport({ client });
    const speech = new Float32Array(4096).fill(0.25);

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: "AAAA",
    });
    pumpMicrophone(speech);
    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);

    pumpMicrophone(speech);
    pumpMicrophone(speech);

    const cancelCalls = vi
      .mocked(client["request"])
      .mock.calls.filter(([method]) => method === "talk.session.cancelOutput");
    expect(cancelCalls).toEqual([
      [
        "talk.session.cancelOutput",
        {
          sessionId: "relay-1",
          reason: "barge-in",
          turnId: "turn-1",
        },
      ],
    ]);
    transport.stop();
  });

  it("treats aborted consult chat events as cancellation", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() => {
      const toolCall = vi
        .mocked(client["request"])
        .mock.calls.find((call) => call[0] === "talk.client.toolCall");
      const params = toolCall?.[1] as { callId?: string; relaySessionId?: string } | undefined;
      expect(params?.callId).toBe("call-1");
      expect(params?.relaySessionId).toBe("relay-1");
    });

    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
      sessionId: "relay-1",
      callId: "call-1",
      result: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    transport.stop();
  });

  it("waits for provider tool-result submission before returning to listening", async () => {
    let resolveSubmission: () => void = () => undefined;
    const submission = new Promise<void>((resolve) => {
      resolveSubmission = resolve;
    });
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      if (method === "talk.session.submitToolResult") {
        await submission;
      }
      return {};
    });
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "final",
        message: { text: "All systems green." },
      },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolResult",
      callId: "call-1",
    });

    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    resolveSubmission();
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    transport.stop();
  });

  it("surfaces rejected provider tool-result submission without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      if (method === "talk.session.submitToolResult") {
        throw new Error("Provider rejected the tool result");
      }
      return {};
    });
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "final",
        message: { text: "All systems green." },
      },
    });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Provider rejected the tool result"),
    );
    expect(onStatus).toHaveBeenLastCalledWith("error", "Provider rejected the tool result");
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1);
    transport.stop();
  });

  it("submits an interim working result for forced consult tool calls", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: { question: "status?" },
    });

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
        sessionId: "relay-1",
        callId: "call-1",
        result: {
          status: "working",
          tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          message:
            "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
        },
        options: { willContinue: true },
      }),
    );
    transport.stop();
  });

  it("releases delayed final tool results when playback is cleared normally", async () => {
    vi.useFakeTimers();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();

    emitTalkEvent({ relaySessionId: "relay-1", type: "clear" });

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
        sessionId: "relay-1",
        callId: "call-1",
        result: { result: "ready" },
      }),
    );
    transport.stop();
  });

  it("releases delayed final tool results on provider barge-in clears", async () => {
    vi.useFakeTimers();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();

    emitTalkEvent({ relaySessionId: "relay-1", type: "clear", reason: "barge-in" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toEqual([
      [
        "talk.session.submitToolResult",
        {
          sessionId: "relay-1",
          callId: "call-1",
          result: { result: "ready" },
        },
      ],
    ]);
    transport.stop();
  });

  it("does not start a forced consult when the working result is terminally cancelled", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.session.submitToolResult") {
        emitTalkEvent({
          relaySessionId: "relay-1",
          type: "toolResult",
          callId: "call-1",
        });
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: { question: "status?" },
    });

    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(0);
    transport.stop();
  });

  it("holds final tool results until overlapping playback cancellations succeed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = createClient();
    const resolveCancellations: Array<(result: unknown) => void> = [];
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      if (method === "talk.session.cancelOutput") {
        return await new Promise<unknown>((resolve) => {
          resolveCancellations.push(resolve);
        });
      }
      return {};
    });
    const transport = await createTransport({ client });
    const speech = new Float32Array(4096).fill(0.25);

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );

    pumpMicrophone(speech);
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    await vi.advanceTimersByTimeAsync(2000);

    expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([
      [
        "talk.session.cancelOutput",
        {
          sessionId: "relay-1",
          reason: "barge-in",
          turnId: "turn-1",
        },
      ],
    ]);
    const appendCountBeforeClear = requestCallsFor(client, "talk.session.appendAudio").length;
    emitTalkEvent({ relaySessionId: "relay-1", type: "clear" });
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(2);
    emitTalkEvent({ relaySessionId: "relay-1", type: "clear" });
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    resolveCancellations[0]?.({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    resolveCancellations[1]?.({ ok: true, status: "applied", turnId: "turn-1" });
    await vi.advanceTimersByTimeAsync(0);
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear + 1,
    );

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toEqual([
      [
        "talk.session.submitToolResult",
        {
          sessionId: "relay-1",
          callId: "call-1",
          result: { result: "ready" },
        },
      ],
    ]);
    const requestCalls = vi.mocked(client["request"]).mock.calls;
    const cancelIndex = requestCalls.findIndex(
      ([method]) => method === "talk.session.cancelOutput",
    );
    const resultIndex = requestCalls.findIndex(
      ([method]) => method === "talk.session.submitToolResult",
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(cancelIndex);
    transport.stop();
  });

  it.each(["stale", "idle"] as const)(
    "retires %s cancellation races without closing or dropping delayed results",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const client = createClient();
      vi.mocked(client["request"]).mockImplementation(async (method) => {
        if (method === "talk.client.toolCall") {
          return {
            runId: "run-1",
            idempotencyKey: "run-1",
            agentId: "main",
            agentSessionKey: "agent:main:main",
          };
        }
        if (method === "talk.session.cancelOutput") {
          return { ok: true, status };
        }
        return {};
      });
      const onStatus = vi.fn();
      const transport = await createTransport({ callbacks: { onStatus }, client });
      const speech = new Float32Array(4096).fill(0.25);

      await startTransport(transport);
      emitTalkEvent({
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      });
      emitTalkEvent({
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      });
      await waitForFast(() =>
        expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
      );
      emitGatewayFrame({
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "ready" } },
      });
      pumpMicrophone(speech);
      pumpMicrophone(speech);
      pumpMicrophone(speech);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1);
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
      expect(onStatus).not.toHaveBeenCalledWith(
        "error",
        "Realtime output cancellation was not accepted.",
      );
      transport.stop();
    },
  );

  it.each([
    ["mismatched", { ok: true, status: "applied", turnId: "turn-2" }],
    ["rejected", { ok: false }],
    ["missing ok", { status: "applied" }],
    ["unknown", { ok: true, status: "unknown" }],
    ["open shape", { ok: true, extra: true }],
  ])(
    "closes without releasing delayed results for %s cancellation results",
    async (_label, cancellationResult) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const client = createClient();
      vi.mocked(client["request"]).mockImplementation(async (method) => {
        if (method === "talk.client.toolCall") {
          return {
            runId: "run-1",
            idempotencyKey: "run-1",
            agentId: "main",
            agentSessionKey: "agent:main:main",
          };
        }
        if (method === "talk.session.cancelOutput") {
          return cancellationResult;
        }
        return {};
      });
      const onStatus = vi.fn();
      const transport = await createTransport({ callbacks: { onStatus }, client });
      const speech = new Float32Array(4096).fill(0.25);

      await startTransport(transport);
      emitTalkEvent({
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      });
      emitTalkEvent({
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      });
      await waitForFast(() =>
        expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
      );
      emitGatewayFrame({
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "ready" } },
      });
      await Promise.resolve();

      pumpMicrophone(speech);
      pumpMicrophone(speech);
      pumpMicrophone(speech);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
      expect(requestCallsFor(client, "talk.session.close")).toEqual([
        ["talk.session.close", { sessionId: "relay-1" }, { timeoutMs: 8_000 }],
      ]);
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime output cancellation was not accepted.",
      );
    },
  );

  it("closes without releasing delayed results when playback cancellation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      if (method === "talk.session.cancelOutput") {
        throw new Error("cancel failed");
      }
      return {};
    });
    const onStatus = vi.fn();
    const transport = await createTransport({ callbacks: { onStatus }, client });
    const speech = new Float32Array(4096).fill(0.25);

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
    });
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();

    pumpMicrophone(speech);
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    expect(requestCallsFor(client, "talk.session.close")).toEqual([
      ["talk.session.close", { sessionId: "relay-1" }, { timeoutMs: 8_000 }],
    ]);
    expect(onStatus).toHaveBeenCalledWith("error", "cancel failed");
  });

  it("treats server relay tool results as terminal for active consult calls", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );

    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolResult",
      callId: "call-1",
      talkEvent: {
        id: "relay-1:1",
        type: "tool.progress",
        sessionId: "relay-1",
        seq: 1,
        timestamp: "2026-05-05T00:00:00.000Z",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        callId: "call-1",
        payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
      } satisfies RealtimeTalkEvent,
    });
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);

    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolResult",
      callId: "call-1",
    });
    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-1",
      }),
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    transport.stop();
  });

  it("aborts an active consult and suppresses its late result after provider cancellation", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );

    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCallCancelled",
      callId: "call-1",
    });

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-1",
      }),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "late answer" } },
    });
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    transport.stop();
  });

  it("suppresses a late control result after provider cancellation", async () => {
    let resolveSteer!: (value: unknown) => void;
    const pendingSteer = new Promise((resolve) => {
      resolveSteer = resolve;
    });
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method, _params, options) => {
      if (method !== "talk.session.steer") {
        return {};
      }
      expect(options).toBeUndefined();
      return await pendingSteer;
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "control-1",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { mode: "status", text: "status" },
    });
    await waitForFast(() => expect(requestCallsFor(client, "talk.session.steer")).toHaveLength(1));

    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCallCancelled",
      callId: "control-1",
    });

    resolveSteer({
      ok: true,
      mode: "status",
      active: true,
      sessionKey: "main",
      message: "late",
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0),
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    transport.stop();
  });

  it("submits a provider cancel result when a relay consult aborts without a server result", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );

    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
        sessionId: "relay-1",
        callId: "call-1",
        result: {
          status: "cancelled",
          message: "Cancelled the active OpenClaw run.",
        },
      }),
    );
    transport.stop();
  });

  it("aborts in-flight consults when the relay transport stops", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method, params) => {
      if (method === "chat.abort") {
        expect(params).toEqual({ sessionKey: "agent:main:main", agentId: "main", runId: "run-1" });
        return { ok: true, aborted: true };
      }
      if (method === "talk.client.toolCall") {
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }
      return {};
    });
    const transport = await createTransport({ client });

    await startTransport(transport);
    emitTalkEvent({
      relaySessionId: "relay-1",
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() => {
      const toolCall = requestCallsFor(client, "talk.client.toolCall")[0];
      const params = toolCall?.[1] as
        | {
            args?: unknown;
            callId?: string;
            name?: string;
            relaySessionId?: string;
            sessionKey?: string;
          }
        | undefined;
      expect(params?.sessionKey).toBe("main");
      expect(params?.callId).toBe("call-1");
      expect(params?.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
      expect(params?.args).toEqual({ question: "status?" });
      expect(params?.relaySessionId).toBe("relay-1");
    });

    transport.stop();
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-1",
      }),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "late answer" } },
    });
    expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
      sessionId: "relay-1",
      callId: "call-1",
      result: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
