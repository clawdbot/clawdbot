import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

export function createOpenAIRealtimeMockState() {
  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    closed = false;
    terminated = false;
    deferClose = false;
    deferredClose: (() => void) | undefined;
    args: unknown[];

    constructor(...args: unknown[]) {
      this.args = args;
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      const emitClose = () => this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
      if (this.deferClose) {
        this.deferredClose = emitClose;
        return;
      }
      emitClose();
    }

    terminate(): void {
      this.terminated = true;
      this.close(1006, "terminated");
    }

    emitDeferredClose(): void {
      const emitClose = this.deferredClose;
      this.deferredClose = undefined;
      emitClose?.();
    }
  }

  return {
    FakeWebSocket: MockWebSocket,
    execFileSyncMock: vi.fn(),
    fetchWithSsrFGuardMock: vi.fn(),
    isProviderAuthProfileConfiguredMock: vi.fn(),
    resolveProviderAuthProfileApiKeyMock: vi.fn(),
  };
}

type FakeWebSocketLike = {
  sent: string[];
  readyState: number;
  emit(event: string, ...args: unknown[]): void;
};

type FakeWebSocketConstructor<T extends FakeWebSocketLike> = {
  new (...args: unknown[]): T;
  readonly OPEN: number;
  instances: T[];
};

type InternalRealtimeVoiceProviderApi = {
  isBrowserSessionConfigured: (ctx: {
    cfg?: object;
    providerConfig: Record<string, unknown>;
    agentId?: string;
  }) => boolean;
  isGatewayRelayConfigured: (ctx: {
    cfg?: object;
    providerConfig: Record<string, unknown>;
    agentId?: string;
  }) => boolean | undefined;
  resolveBrowserSessionCapabilities: (ctx: {
    cfg?: object;
    providerConfig: Record<string, unknown>;
    model?: string;
  }) => {
    handlesAgentConsult?: boolean;
    supportsToolCalls?: boolean;
    supportsVideoFrames?: boolean;
    supportsGatewayControl?: boolean;
    transports?: string[];
  };
  resolveGatewayRelayCapabilities: (ctx: {
    cfg?: object;
    providerConfig: Record<string, unknown>;
    model?: string;
  }) => {
    handlesAgentConsult?: boolean;
    supportsToolCalls?: boolean;
    transports?: string[];
  };
  validateGatewayRelayLaunch: (ctx: {
    cfg?: object;
    providerConfig: Record<string, unknown>;
    model?: string;
    autoRespondToAudio?: boolean;
  }) => string | undefined;
};

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");
const OPENAI_REALTIME_REJECTED_KEY_MESSAGE =
  "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source";

export function createOpenAIRealtimeTestSupport<T extends FakeWebSocketLike>(deps: {
  FakeWebSocket: FakeWebSocketConstructor<T>;
  execFileSyncMock: ReturnType<typeof vi.fn>;
  fetchWithSsrFGuardMock: ReturnType<typeof vi.fn>;
  isProviderAuthProfileConfiguredMock: ReturnType<typeof vi.fn>;
  resolveProviderAuthProfileApiKeyMock: ReturnType<typeof vi.fn>;
  buildOpenAIRealtimeVoiceProvider: () => RealtimeVoiceProviderPlugin;
}) {
  const {
    FakeWebSocket,
    execFileSyncMock,
    fetchWithSsrFGuardMock,
    isProviderAuthProfileConfiguredMock,
    resolveProviderAuthProfileApiKeyMock,
    buildOpenAIRealtimeVoiceProvider,
  } = deps;
  type FakeWebSocketInstance = T;
  type SentRealtimeEvent = {
    type: string;
    event_id?: string;
    audio?: string;
    item_id?: string;
    item?: unknown;
    content_index?: number;
    audio_end_ms?: number;
    session?: {
      type?: string;
      model?: string;
      modalities?: string[];
      instructions?: string;
      voice?: string;
      input_audio_format?: string;
      output_audio_format?: string;
      input_audio_transcription?: Record<string, unknown>;
      turn_detection?: {
        create_response?: boolean;
      };
      output_modalities?: string[];
      tools?: Array<{ name?: string }>;
      audio?: {
        input?: {
          format?: Record<string, unknown>;
          noise_reduction?: Record<string, unknown> | null;
          transcription?: Record<string, unknown>;
          turn_detection?: {
            create_response?: boolean;
            interrupt_response?: boolean;
          };
        };
        output?: {
          format?: Record<string, unknown>;
          voice?: string;
        };
      };
    };
  };

  function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
    return socket.sent.map((payload: string) => JSON.parse(payload) as SentRealtimeEvent);
  }

  function resetTestState(): void {
    FakeWebSocket.instances = [];
    vi.stubEnv("OPENAI_API_KEY", "");
    execFileSyncMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveProviderAuthProfileApiKeyMock.mockReset();
    resolveProviderAuthProfileApiKeyMock.mockResolvedValue(undefined);
  }

  function restoreTestEnvironment(): void {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }

  function readInternalRealtimeVoiceProviderApi(
    provider: object,
  ): InternalRealtimeVoiceProviderApi {
    return Reflect.get(
      provider,
      INTERNAL_REALTIME_VOICE_PROVIDER,
    ) as InternalRealtimeVoiceProviderApi;
  }

  function createNativeBridge(
    overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
  ): RealtimeVoiceBridge {
    return buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-api-key-test" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      ...overrides,
    });
  }

  function requireSocket(index = 0): FakeWebSocketInstance {
    const socket = FakeWebSocket.instances[index];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }
    return socket;
  }

  function beginBridgeConnection(
    bridge: RealtimeVoiceBridge,
    socketIndex = 0,
  ): { connecting: Promise<void>; socket: FakeWebSocketInstance } {
    const connecting = bridge.connect();
    return { connecting, socket: requireSocket(socketIndex) };
  }

  function openSocket(socket: FakeWebSocketInstance): void {
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
  }

  function emitServerEvent(socket: FakeWebSocketInstance, event: Record<string, unknown>): void {
    socket.emit("message", Buffer.from(JSON.stringify(event)));
  }

  function emitSessionUpdated(socket: FakeWebSocketInstance): void {
    emitServerEvent(socket, { type: "session.updated" });
  }

  function emitAssistantPlayback(
    socket: FakeWebSocketInstance,
    overrides: { responseId?: string; itemId?: string; audio?: Buffer } = {},
  ): void {
    emitServerEvent(socket, {
      type: "response.created",
      response: { id: overrides.responseId ?? "resp_1" },
    });
    emitServerEvent(socket, {
      type: "response.audio.delta",
      item_id: overrides.itemId ?? "item_1",
      delta: (overrides.audio ?? Buffer.from("assistant audio")).toString("base64"),
    });
  }

  function emitCompletedToolCalls(
    socket: FakeWebSocketInstance,
    callIds: string[] = ["call_1"],
  ): void {
    emitServerEvent(socket, {
      type: "response.done",
      response: {
        id: "response_tools",
        status: "completed",
        output: callIds.map((callId, index) => ({
          id: `item_${index + 1}`,
          type: "function_call",
          status: "completed",
          call_id: callId,
          name: "lookup_weather",
          arguments: "{}",
        })),
      },
    });
  }

  function emitFunctionOutputAdded(socket: FakeWebSocketInstance, callId: string): void {
    emitServerEvent(socket, {
      type: "conversation.item.added",
      item: { type: "function_call_output", call_id: callId },
    });
  }

  function expectedFunctionOutput(callId: string, result: unknown) {
    return expect.objectContaining({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  }

  async function connectReadyBridge(
    bridge: RealtimeVoiceBridge,
    socketIndex = 0,
  ): Promise<FakeWebSocketInstance> {
    const { connecting, socket } = beginBridgeConnection(bridge, socketIndex);
    openSocket(socket);
    emitSessionUpdated(socket);
    await connecting;
    return socket;
  }

  function expectedResponseCreateEvent() {
    return expect.objectContaining({
      type: "response.create",
      event_id: expect.stringMatching(/^openclaw-response-create-/),
    });
  }

  function expectedResponseCancelEvent() {
    return expect.objectContaining({
      type: "response.cancel",
      event_id: expect.stringMatching(/^openclaw-response-cancel-/),
    });
  }

  function createJsonResponse(body: unknown, init?: { status?: number }): Response {
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  function mockRealtimeClientSecretResponse(
    overrides: { clientSecret?: string; expiresAt?: number } = {},
  ): ReturnType<typeof vi.fn> {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse({
        client_secret: { value: overrides.clientSecret ?? "client-secret-123" },
        ...(overrides.expiresAt === undefined ? {} : { expires_at: overrides.expiresAt }),
      }),
      release,
    });
    return release;
  }

  function createQuicksilverBrowserBrokerFixture(
    overrides: {
      session?: {
        provider?: "openai";
        transport?: "webrtc";
        clientSecret?: string;
        offerUrl?: string;
      };
      capabilities?: {
        handlesAgentConsult?: true;
        supportsToolCalls?: boolean;
        supportsVideoFrames?: boolean;
        transports?: Array<"webrtc">;
      };
    } = {},
  ) {
    const session: RealtimeVoiceBrowserSession = {
      provider: "openai" as const,
      transport: "webrtc" as const,
      clientSecret: "quicksilver-token",
      offerUrl: "/plugins/openai/realtime/calls",
      ...overrides.session,
    };
    const createBrowserSession = vi.fn(
      async (_request: unknown, _auth: unknown): Promise<RealtimeVoiceBrowserSession> => session,
    );
    const cancelBrowserSession = vi.fn(async (_session: RealtimeVoiceBrowserSession) => undefined);
    const broker = {
      capabilities: {
        transports: ["webrtc" as const],
        handlesAgentConsult: true as const,
        supportsToolCalls: false,
        supportsVideoFrames: false,
        ...overrides.capabilities,
      },
      createBrowserSession,
      cancelBrowserSession,
    };
    return { broker, createBrowserSession, cancelBrowserSession };
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return value as Record<string, unknown>;
  }

  function requireNestedRecord(
    value: unknown,
    path: readonly string[],
    label = path.join("."),
  ): Record<string, unknown> {
    let current = requireRecord(value, label);
    for (const key of path) {
      current = requireRecord(current[key], `${label}.${key}`);
    }
    return current;
  }

  function expectRecordFields(
    value: unknown,
    label: string,
    expected: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(value, label);
    for (const [key, expectedValue] of Object.entries(expected)) {
      expect(record[key], `${label}.${key}`).toEqual(expectedValue);
    }
    return record;
  }

  function firstMockCall(
    mock: { mock: { calls: Array<readonly unknown[]> } },
    label: string,
  ): readonly unknown[] {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error(`expected ${label} call`);
    }
    return call;
  }

  function requireFetchRequest(callIndex = 0): Record<string, unknown> {
    return requireRecord(fetchWithSsrFGuardMock.mock.calls[callIndex]?.[0], "fetch request");
  }

  function requireFetchInit(callIndex = 0): Record<string, unknown> {
    return requireRecord(requireFetchRequest(callIndex).init, "fetch init");
  }

  function requireFetchHeaders(callIndex = 0): Record<string, unknown> {
    return requireRecord(requireFetchInit(callIndex).headers, "fetch headers");
  }

  function requireFetchJsonBody(callIndex = 0): Record<string, unknown> {
    const body = requireFetchInit(callIndex).body;
    expect(typeof body, "fetch body must be a JSON string").toBe("string");
    return requireRecord(JSON.parse(body as string), "fetch JSON body");
  }

  function requireSession(socket: FakeWebSocketInstance, index = 0): Record<string, unknown> {
    return requireRecord(parseSent(socket)[index]?.session, "session");
  }

  function hasSentEventType(socket: FakeWebSocketInstance, type: string): boolean {
    return parseSent(socket).some((event) => event.type === type);
  }

  function createRealtimeTool(name: string): RealtimeVoiceTool {
    return {
      type: "function",
      name,
      description: "Contract test tool",
      parameters: { type: "object", properties: {} },
    };
  }

  function createUnreadableToolName(): RealtimeVoiceTool {
    return {
      type: "function",
      get name(): string {
        throw new Error("unreadable tool name");
      },
      description: "Contract test tool",
      parameters: { type: "object", properties: {} },
    };
  }

  function createMalformedToolName(name: unknown): RealtimeVoiceTool {
    return {
      type: "function",
      name,
      description: "Contract test tool",
      parameters: { type: "object", properties: {} },
    } as unknown as RealtimeVoiceTool;
  }

  function createTestJwt(payload: Record<string, unknown>): string {
    return [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "test-signature",
    ].join(".");
  }

  return {
    resetTestState,
    restoreTestEnvironment,
    readInternalRealtimeVoiceProviderApi,
    parseSent,
    createNativeBridge,
    requireSocket,
    beginBridgeConnection,
    openSocket,
    emitServerEvent,
    emitSessionUpdated,
    emitAssistantPlayback,
    emitCompletedToolCalls,
    emitFunctionOutputAdded,
    expectedFunctionOutput,
    connectReadyBridge,
    expectedResponseCreateEvent,
    expectedResponseCancelEvent,
    createJsonResponse,
    createQuicksilverBrowserBrokerFixture,
    mockRealtimeClientSecretResponse,
    rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
    requireRecord,
    requireNestedRecord,
    expectRecordFields,
    firstMockCall,
    requireFetchRequest,
    requireFetchInit,
    requireFetchHeaders,
    requireFetchJsonBody,
    requireSession,
    hasSentEventType,
    createRealtimeTool,
    createUnreadableToolName,
    createMalformedToolName,
    createTestJwt,
  };
}
