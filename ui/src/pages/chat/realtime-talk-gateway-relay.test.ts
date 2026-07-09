// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let getUserMedia: ReturnType<typeof vi.fn>;

class MockAudioContext {
  readonly currentTime = 0;
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
    vi.unstubAllGlobals();
    listeners.clear();
    processors.length = 0;
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
    await vi.waitFor(() =>
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
    await vi.waitFor(() => {
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

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
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

    await vi.waitFor(() =>
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
    await vi.waitFor(() => expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1));

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

    await vi.waitFor(() =>
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
    await vi.waitFor(() => expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1));

    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await vi.waitFor(() =>
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() =>
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
