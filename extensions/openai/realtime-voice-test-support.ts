import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

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

export function createOpenAIRealtimeTestSupport<T extends FakeWebSocketLike>(deps: {
  FakeWebSocket: FakeWebSocketConstructor<T>;
  fetchWithSsrFGuardMock: ReturnType<typeof vi.fn>;
}) {
  const { FakeWebSocket, fetchWithSsrFGuardMock } = deps;
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
    parseSent,
    createNativeBridge,
    requireSocket,
    beginBridgeConnection,
    openSocket,
    emitServerEvent,
    emitSessionUpdated,
    emitCompletedToolCalls,
    emitFunctionOutputAdded,
    expectedFunctionOutput,
    connectReadyBridge,
    expectedResponseCreateEvent,
    expectedResponseCancelEvent,
    createJsonResponse,
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
