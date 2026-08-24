import { afterEach, beforeEach, expect, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
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

export const wsInstances: MockGoogleLiveWebSocket[] = [];
export const audioContexts: MockAudioContext[] = [];
export const createdSources: MockAudioBufferSource[] = [];
export const inputProcessors: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
}> = [];
export const inputSinks: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: { value: number };
}> = [];

export const googleLiveTestFixture = {
  getUserMedia: vi.fn(),
  stopInputTrack: vi.fn(),
};

export async function flushMicrotasks(): Promise<void> {
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

  emitClose() {
    this.readyState = 3;
    for (const handler of this.handlers.close) {
      handler();
    }
  }

  emitError() {
    for (const handler of this.handlers.error) {
      handler();
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
    audioContexts.push(this);
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

export function createSession(
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

export function createClient(): RealtimeTalkTransportContext["client"] {
  const client = {
    addEventListener: vi.fn(() => () => undefined),
    request: vi.fn(),
  } as unknown as RealtimeTalkTransportContext["client"];
  return client;
}

export function createTransport(
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

export function encodeJsonFrame(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

export function latestWebSocket(): MockGoogleLiveWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing WebSocket");
  }
  return ws;
}

export async function beginTransport(transport: GoogleLiveRealtimeTalkTransport): Promise<{
  start: Promise<"ready" | "cancelled">;
  ws: MockGoogleLiveWebSocket;
}> {
  const start = transport.start();
  await waitForFast(() => expect(wsInstances).toHaveLength(1));
  return { start, ws: latestWebSocket() };
}

export async function startTransport(
  transport: GoogleLiveRealtimeTalkTransport,
): Promise<MockGoogleLiveWebSocket> {
  const { start, ws } = await beginTransport(transport);
  ws.emitOpen();
  ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));
  await expect(start).resolves.toBe("ready");
  transport.activate();
  return ws;
}

export function pumpMicrophone(samples: Float32Array): void {
  const processor = inputProcessors.at(-1);
  if (!processor) {
    throw new Error("missing microphone processor");
  }
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
}

export function requireFirstTalkEvent(
  onTalkEvent: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
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

export function getGoogleLiveToolOwnerState(transport: GoogleLiveRealtimeTalkTransport): {
  pendingCalls: Map<string, { name: string; cancelled: boolean }>;
  seenCallIds: Set<string>;
} {
  return (
    transport as unknown as {
      toolOwner: {
        pendingCalls: Map<string, { name: string; cancelled: boolean }>;
        seenCallIds: Set<string>;
      };
    }
  ).toolOwner;
}

export function installGoogleLiveTestFixture(): void {
  beforeEach(() => {
    wsInstances.length = 0;
    audioContexts.length = 0;
    createdSources.length = 0;
    inputProcessors.length = 0;
    inputSinks.length = 0;
    vi.stubGlobal("WebSocket", MockGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    googleLiveTestFixture.stopInputTrack = vi.fn();
    googleLiveTestFixture.getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: googleLiveTestFixture.stopInputTrack }],
    }));
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: googleLiveTestFixture.getUserMedia,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
