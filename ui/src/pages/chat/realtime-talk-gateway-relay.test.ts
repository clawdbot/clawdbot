// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
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
let getUserMedia: ReturnType<typeof vi.fn>;
let audioCurrentTime = 0;

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
    return {
      addEventListener: vi.fn(),
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
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

function emitGatewayFrame(frame: GatewayFrame): void {
  for (const listener of listeners) {
    listener(frame);
  }
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
    audioCurrentTime = 0;
    vi.stubGlobal("AudioContext", MockAudioContext);
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
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
  });

  it("preserves audio processing while selecting the exact microphone", async () => {
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client: createClient(),
      sessionKey: "main",
      inputDeviceId: "usb-mic",
    });

    await transport.start();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
    transport.stop();
  });

  it("keeps the microphone processor inaudible locally", async () => {
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client: createClient(),
      sessionKey: "main",
    });

    await transport.start();

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

  it("releases microphone access that resolves after stop", async () => {
    let resolveMedia: (media: MediaStream) => void = () => undefined;
    const pendingMedia = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    getUserMedia.mockReturnValue(pendingMedia);
    const stopTrack = vi.fn();
    const onInputLevel = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onInputLevel },
      client: createClient(),
      sessionKey: "main",
    });

    const start = transport.start();
    transport.stop();
    resolveMedia({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await start;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(processors).toHaveLength(0);
    expect(onInputLevel).not.toHaveBeenCalled();
  });

  it("forwards common Talk events from Gateway relay frames", async () => {
    const onTalkEvent = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
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

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "ready",
        talkEvent,
      },
    });

    expect(onTalkEvent).toHaveBeenCalledWith(talkEvent);
    transport.stop();
  });

  it("does not forward Talk events for another relay session", async () => {
    const onTalkEvent = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onTalkEvent },
      client: createClient(),
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
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
      },
    });

    expect(onTalkEvent).not.toHaveBeenCalled();
    transport.stop();
  });

  it("keeps assistant playback alive while relay input is silence", async () => {
    const client = createClient();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: "AAAA",
      },
    });
    pumpMicrophone(new Float32Array(4096));

    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
    const appendCall = vi
      .mocked(client["request"])
      .mock.calls.find((call) => call[0] === "talk.session.appendAudio");
    expect((appendCall?.[1] as { sessionId?: string } | undefined)?.sessionId).toBe("relay-1");
    transport.stop();
  });

  it("acknowledges provider marks only after the local playback queue drains", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: { relaySessionId: "relay-1", type: "mark", markName: "mark-1" },
    });

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
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: { relaySessionId: "relay-1", type: "mark", markName: "mark-1" },
    });

    expect(vi.getTimerCount()).toBe(1);
    transport.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
  });

  it("reports microphone activity and resets it when stopped", async () => {
    const onInputLevel = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onInputLevel },
      client: createClient(),
      sessionKey: "main",
    });

    await transport.start();
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096).fill(0.25));
    transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
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
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
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
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
    pumpMicrophone(new Float32Array(4096));
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "close",
        reason: "error",
      },
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

  it("preserves relay error details across close events", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "error",
        message: "API version mismatch",
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "close",
        reason: "error",
      },
    });

    expect(onStatus).toHaveBeenCalledWith("error", "API version mismatch");
    expect(onStatus).toHaveBeenLastCalledWith("error", "API version mismatch");
  });

  it("cancels relay playback after sustained input speech", async () => {
    const client = createClient();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });
    const speech = new Float32Array(4096).fill(0.25);

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: "AAAA",
      },
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
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
        return { runId: "run-1" };
      }
      if (method === "talk.session.submitToolResult") {
        await submission;
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolResult",
        callId: "call-1",
      },
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
        return { runId: "run-1" };
      }
      if (method === "talk.session.submitToolResult") {
        throw new Error("Provider rejected the tool result");
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        forced: true,
        args: { question: "status?" },
      },
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
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();

    emitGatewayFrame({
      event: "talk.event",
      payload: { relaySessionId: "relay-1", type: "clear" },
    });

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
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();

    emitGatewayFrame({
      event: "talk.event",
      payload: { relaySessionId: "relay-1", type: "clear", reason: "barge-in" },
    });
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
        emitGatewayFrame({
          event: "talk.event",
          payload: {
            relaySessionId: "relay-1",
            type: "toolResult",
            callId: "call-1",
          },
        });
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        forced: true,
        args: { question: "status?" },
      },
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
    const resolveCancellations: Array<() => void> = [];
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.session.cancelOutput") {
        return await new Promise<Record<string, never>>((resolve) => {
          resolveCancellations.push(() => resolve({}));
        });
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });
    const speech = new Float32Array(4096).fill(0.25);

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
        },
      ],
    ]);
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    pumpMicrophone(speech);
    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(2);
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "ready" } },
    });
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    resolveCancellations[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    resolveCancellations[1]?.();
    await vi.advanceTimersByTimeAsync(0);

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

  it("closes without releasing delayed results when playback cancellation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.session.cancelOutput") {
        throw new Error("cancel failed");
      }
      return {};
    });
    const onStatus = vi.fn();
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: { onStatus },
      client,
      sessionKey: "main",
    });
    const speech = new Float32Array(4096).fill(0.25);

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "audio",
        audioBase64: zeroPcmBase64(24000),
      },
    });
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
      ["talk.session.close", { sessionId: "relay-1" }],
    ]);
    expect(onStatus).toHaveBeenCalledWith("error", "cancel failed");
  });

  it("treats server relay tool results as terminal for active consult calls", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1),
    );

    emitGatewayFrame({
      event: "talk.event",
      payload: {
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
      },
    });
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);

    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolResult",
        callId: "call-1",
      },
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
        sessionKey: "main",
        runId: "run-1",
      }),
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    transport.stop();
  });

  it("submits a provider cancel result when a relay consult aborts without a server result", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
        expect(params).toEqual({ sessionKey: "main", runId: "run-1" });
        return { ok: true, aborted: true };
      }
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      return {};
    });
    const transport = new GatewayRelayRealtimeTalkTransport(createSession(), {
      callbacks: {},
      client,
      sessionKey: "main",
    });

    await transport.start();
    emitGatewayFrame({
      event: "talk.event",
      payload: {
        relaySessionId: "relay-1",
        type: "toolCall",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      },
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
        sessionKey: "main",
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
