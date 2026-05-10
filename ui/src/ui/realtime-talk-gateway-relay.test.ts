// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRelayRealtimeTalkTransport } from "./chat/realtime-talk-gateway-relay.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeTalkEvent,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkTransportContext,
} from "./chat/realtime-talk-shared.ts";

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

describe("GatewayRelayRealtimeTalkTransport", () => {
  beforeEach(() => {
    listeners.clear();
    processors.length = 0;
    vi.stubGlobal("AudioContext", MockAudioContext);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    listeners.clear();
    processors.length = 0;
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

    expect(client.request).not.toHaveBeenCalledWith("talk.session.cancelOutput", expect.anything());
    expect(client.request).toHaveBeenCalledWith(
      "talk.session.appendAudio",
      expect.objectContaining({ sessionId: "relay-1" }),
    );
    transport.stop();
  });

  it("stops microphone pumping when the relay rejects appended audio", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client.request).mockImplementation(async (method) => {
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
      .mocked(client.request)
      .mock.calls.filter(([method]) => method === "talk.session.appendAudio");
    const closeCalls = vi
      .mocked(client.request)
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
      .mocked(client.request)
      .mock.calls.filter(([method]) => method === "talk.session.appendAudio");
    const closeCalls = vi
      .mocked(client.request)
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
    expect(client.request).not.toHaveBeenCalledWith("talk.session.cancelOutput", expect.anything());

    pumpMicrophone(speech);
    pumpMicrophone(speech);

    const cancelCalls = vi
      .mocked(client.request)
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
    vi.mocked(client.request).mockImplementation(async (method) => {
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
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        "talk.client.toolCall",
        expect.objectContaining({
          callId: "call-1",
          relaySessionId: "relay-1",
        }),
      ),
    );

    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    expect(
      vi
        .mocked(client.request)
        .mock.calls.some(([method]) => method === "talk.session.submitToolResult"),
    ).toBe(false);
    transport.stop();
  });

  it("aborts in-flight consults when the relay transport stops", async () => {
    const client = createClient();
    vi.mocked(client.request).mockImplementation(async (method, params) => {
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
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith("talk.client.toolCall", expect.anything()),
    );

    transport.stop();
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "main",
        runId: "run-1",
      }),
    );
    emitGatewayFrame({
      event: "chat",
      payload: { runId: "run-1", state: "final", message: { text: "late answer" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      vi
        .mocked(client.request)
        .mock.calls.some(([method]) => method === "talk.session.submitToolResult"),
    ).toBe(false);
  });
});
