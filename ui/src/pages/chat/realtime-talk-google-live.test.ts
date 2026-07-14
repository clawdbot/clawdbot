// Control UI tests cover realtime talk google live behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./realtime-talk-shared.ts";
import type {
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

type MockWebSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
};

type MockWebSocketHandler = (event?: MockWebSocketEvent) => void;
type MockWebSocketEventType = "close" | "error" | "message" | "open";

const wsInstances: MockGoogleLiveWebSocket[] = [];
const createdSources: MockAudioBufferSource[] = [];
const inputProcessors: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
}> = [];
const inputSinks: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: { value: number };
}> = [];
let getUserMedia: ReturnType<typeof vi.fn>;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class MockGoogleLiveWebSocket {
  static OPEN = 1;

  readonly handlers: Record<MockWebSocketEventType, MockWebSocketHandler[]> = {
    close: [],
    error: [],
    message: [],
    open: [],
  };
  readonly sent: string[] = [];
  binaryType: BinaryType = "blob";
  readyState = MockGoogleLiveWebSocket.OPEN;

  constructor(readonly url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: MockWebSocketEventType, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    for (const handler of this.handlers.message) {
      handler({ data });
    }
  }
}

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  readonly close = vi.fn(async () => undefined);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    const processor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    inputProcessors.push(processor);
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

function createSession(
  websocketUrl: string,
  clientSecret = "auth_tokens/browser-session",
): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "google",
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret,
    websocketUrl,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

function createClient(): RealtimeTalkTransportContext["client"] {
  const client = {
    addEventListener: vi.fn(() => () => undefined),
    request: vi.fn(),
  } as unknown as RealtimeTalkTransportContext["client"];
  return client;
}

function createTransport(
  callbacks: RealtimeTalkTransportContext["callbacks"] = {},
  client = createClient(),
  inputDeviceId?: string,
) {
  return new GoogleLiveRealtimeTalkTransport(
    createSession(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    ),
    {
      callbacks,
      client,
      sessionKey: "main",
      inputDeviceId,
    },
  );
}

function encodeJsonFrame(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function latestWebSocket(): MockGoogleLiveWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing WebSocket");
  }
  return ws;
}

function pumpMicrophone(samples: Float32Array): void {
  const processor = inputProcessors.at(-1);
  if (!processor) {
    throw new Error("missing microphone processor");
  }
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
}

function requireFirstTalkEvent(onTalkEvent: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [call] = onTalkEvent.mock.calls;
  if (!call) {
    throw new Error("expected talk event");
  }
  const [event] = call;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("expected talk event record");
  }
  return event as Record<string, unknown>;
}

describe("GoogleLiveRealtimeTalkTransport", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    createdSources.length = 0;
    inputProcessors.length = 0;
    inputSinks.length = 0;
    vi.stubGlobal("WebSocket", MockGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
    }));
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects only to the allowlisted endpoint with the ephemeral token", async () => {
    const transport = new GoogleLiveRealtimeTalkTransport(
      createSession(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?ignored=1",
      ),
      { callbacks: {}, client: createClient(), sessionKey: "main" },
    );

    await transport.start();

    expect(latestWebSocket().url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-session",
    );
    transport.stop();
  });

  it.each([
    "ws://generativelanguage.googleapis.com/ws/google.ai",
    "wss://attacker.test/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    "wss://generativelanguage.googleapis.com/evil",
  ])("rejects attacker-controlled WebSocket URL %s", async (websocketUrl) => {
    const transport = new GoogleLiveRealtimeTalkTransport(createSession(websocketUrl), {
      callbacks: {},
      client: createClient(),
      sessionKey: "main",
    });

    await expect(transport.start()).rejects.toThrow(/wss:\/\/|Untrusted Google Live WebSocket/u);
    expect(wsInstances).toHaveLength(0);
  });

  it("captures from the selected microphone with an exact constraint", async () => {
    const transport = createTransport({}, createClient(), "usb-mic");

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
    const transport = createTransport();

    await transport.start();
    latestWebSocket().emitOpen();

    const processor = inputProcessors.at(-1);
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
    const transport = createTransport({ onInputLevel });

    const start = transport.start();
    transport.stop();
    resolveMedia({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await start;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(inputProcessors).toHaveLength(0);
    expect(wsInstances).toHaveLength(0);
    expect(onInputLevel).not.toHaveBeenCalled();
  });

  it("requests ArrayBuffer frames and decodes binary setup messages", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });

    await transport.start();
    const ws = latestWebSocket();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));

    expect(ws.binaryType).toBe("arraybuffer");
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    const readyEvent = requireFirstTalkEvent(onTalkEvent);
    expect(readyEvent.type).toBe("session.ready");
    expect(readyEvent.sessionId).toBe("main:google:provider-websocket");
    expect(readyEvent.transport).toBe("provider-websocket");
  });

  it("reports microphone activity and resets it when stopped", async () => {
    const onInputLevel = vi.fn();
    const transport = createTransport({ onInputLevel });

    await transport.start();
    latestWebSocket().emitOpen();
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096).fill(0.25));
    transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

  it("decodes Blob setup messages", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    await transport.start();
    latestWebSocket().emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
  });

  it("stops queued output when Google Live sends interruption", async () => {
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent });
    await transport.start();
    const ws = latestWebSocket();

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));

    const source = createdSources[0];
    ws.emitMessage(encodeJsonFrame({ serverContent: { interrupted: true } }));

    await vi.waitFor(() => expect(source?.stop).toHaveBeenCalledTimes(1));
    const cancelledEvent = onTalkEvent.mock.calls.find(
      ([event]) => event.type === "turn.cancelled",
    )?.[0];
    expect(cancelledEvent?.final).toBe(true);
    expect(cancelledEvent?.payload).toStrictEqual({ reason: "provider-interrupted" });
  });

  it("emits common Talk events for Google Live transcript and audio frames", async () => {
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent, onTranscript });

    await transport.start();
    latestWebSocket().emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "hello", finished: true },
          outputTranscription: { text: "hi", finished: false },
          modelTurn: {
            parts: [
              { inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } },
              { text: "there" },
            ],
          },
          turnComplete: true,
        },
      }),
    );

    await vi.waitFor(() =>
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "transcript.done",
        "output.text.delta",
        "output.audio.delta",
        "output.text.done",
        "turn.ended",
      ]),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
    ]);
    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({ role: "assistant", text: "hi", final: false });
    const audioEvent = onTalkEvent.mock.calls[2]?.[0];
    expect(audioEvent?.payload).toStrictEqual({ byteLength: 4, mimeType: "audio/pcm;rate=24000" });
    expect(audioEvent?.sessionId).toBe("main:google:provider-websocket");
    expect(audioEvent?.transport).toBe("provider-websocket");
  });

  it("ignores late WebSocket events after stop", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    await transport.start();
    const ws = latestWebSocket();

    transport.stop();
    ws.emitOpen();
    ws.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));

    await flushMicrotasks();
    expect(ws.sent).toStrictEqual([]);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("does not revive Talk status after stop while a tool consult settles", async () => {
    const onStatus = vi.fn();
    const runId = "run-1";
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const client = {
      addEventListener: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "chat.abort") {
          expect(params).toEqual({ sessionKey: "main", runId });
          return { ok: true, aborted: true };
        }
        expect(method).toBe("talk.client.toolCall");
        expect(params.callId).toBe("call-1");
        expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
        return { runId };
      }),
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = createTransport({ onStatus }, client);
    await transport.start();

    latestWebSocket().emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "check the session" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("thinking", undefined));
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    transport.stop();
    for (const listener of listeners) {
      listener({ event: "chat", payload: { runId, state: "final", message: { text: "done" } } });
    }

    await vi.waitFor(() => {
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", { sessionKey: "main", runId });
    });
    expect(onStatus).not.toHaveBeenCalledWith("listening");
  });

  it("submits completed consults without asynchronous scheduling", async () => {
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const client = {
      addEventListener: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request: vi.fn(async (method: string) => {
        expect(method).toBe("talk.client.toolCall");
        return { runId: "run-1" };
      }),
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = createTransport({}, client);
    await transport.start();
    const ws = latestWebSocket();

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "check the session" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    for (const listener of listeners) {
      listener({
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "done" } },
      });
    }

    await vi.waitFor(() =>
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              response: { result: "done" },
            },
          ],
        },
      }),
    );
    transport.stop();
  });

  it("surfaces Google Live tool-result send failures without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({ onStatus, onTalkEvent }, client);

    await transport.start();
    const ws = latestWebSocket();
    vi.spyOn(ws, "send").mockImplementation(() => {
      throw new Error("Google Live socket rejected the tool result");
    });
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-control",
              name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
              args: { text: "status", mode: "status" },
            },
          ],
        },
      }),
    );

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Google Live socket rejected the tool result"),
    );
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          (event.type === "tool.progress" || event.type === "tool.error") && event.final === true,
      ),
    ).toBe(false);
    expect(
      (
        transport as unknown as {
          pendingCalls: Map<string, unknown>;
        }
      ).pendingCalls.has("call-control"),
    ).toBe(true);
    expect(() =>
      (
        transport as unknown as {
          submitToolResult: (callId: string, result: unknown) => void;
        }
      ).submitToolResult("missing-call", { ok: true }),
    ).toThrow("Google Live has no pending tool call for missing-call");
    transport.stop();
  });

  it("sends spoken active-control acknowledgements through Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "OpenClaw is working in read (running).",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    await transport.start();
    const ws = latestWebSocket();
    ws.emitOpen();
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "status", finished: true },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent).toContainEqual({
      realtimeInput: {
        text: expect.stringContaining('Status: "OpenClaw is working in read (running)."'),
      },
    });
    transport.stop();
  });

  it("replaces queued output with a spoken active-control steering acknowledgement in Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "steer",
          sessionKey: "main",
          active: true,
          queued: true,
          message: "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    await transport.start();
    const ws = latestWebSocket();
    ws.emitOpen();
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "actually focus on WebUI", finished: true },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent).toContainEqual({
      realtimeInput: {
        text: expect.stringContaining('Status: "Got it. I steered the active run."'),
      },
    });
    transport.stop();
  });

  it("interrupts queued output when active-control cancel is suppressed in Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "cancel",
          sessionKey: "main",
          active: true,
          aborted: true,
          message: "Cancelled the active OpenClaw run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    await transport.start();
    const ws = latestWebSocket();
    ws.emitOpen();
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "cancel that", finished: true },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent.some((event) => event.clientContent)).toBe(false);
    transport.stop();
  });
});
