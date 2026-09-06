import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  createNativeBridge,
  connectReadyBridge,
  parseSent,
  emitServerEvent,
  emitCompletedToolCalls,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({
  ...mocks,
  buildOpenAIRealtimeVoiceProvider,
});

describe("OpenAI realtime outgoing response ownership", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it.each(["manual", "standalone"])(
    "sends %s creation before its observer can cancel",
    async (mode) => {
      const onAudio = vi.fn();
      let cancelled = false;
      const bridge: RealtimeVoiceBridge = createNativeBridge({
        autoRespondToAudio: false,
        onAudio,
        onToolCall: vi.fn(),
        onEvent: (event) => {
          if (event.direction === "client" && event.type === "response.create" && !cancelled) {
            cancelled = true;
            bridge.handleBargeIn?.({ force: true });
          }
        },
      });
      const socket = await connectReadyBridge(bridge);
      if (mode === "standalone") {
        emitCompletedToolCalls(socket);
      }
      bridge.sendUserMessage?.("First response.");
      expect(
        parseSent(socket)
          .filter((event) => event.type.startsWith("response."))
          .map((event) => event.type),
      ).toEqual(["response.create", "response.cancel"]);
      emitServerEvent(socket, { type: "response.created", response: { id: "cancelled" } });
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "discarded",
        delta: Buffer.alloc(320).toString("base64"),
      });
      expect(onAudio).not.toHaveBeenCalled();
      bridge.sendUserMessage?.("Follow-up response.");
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
      emitServerEvent(socket, {
        type: "response.done",
        response: { id: "cancelled", status: "cancelled", output: [] },
      });
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(2);
      emitServerEvent(socket, { type: "response.created", response: { id: "recovery" } });
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "heard",
        delta: Buffer.alloc(320).toString("base64"),
      });
      expect(onAudio).toHaveBeenCalledTimes(1);
      bridge.close();
    },
  );

  it.each([false, true])(
    "cancels during VAD suppression and preserves replacement admission (clear requests replacement=%s)",
    async (replaceOnClear) => {
      let cancelSuppression = false;
      const bridge: RealtimeVoiceBridge = createNativeBridge({
        onClearAudio: () => {
          if (replaceOnClear) {
            bridge.sendUserMessage?.("Replacement from the clear callback.");
          }
        },
        onEvent: (event) => {
          if (
            cancelSuppression &&
            event.direction === "client" &&
            event.type === "session.update"
          ) {
            cancelSuppression = false;
            bridge.handleBargeIn?.({ force: true });
          }
        },
      });
      const socket = await connectReadyBridge(bridge);
      cancelSuppression = true;
      bridge.sendUserMessage?.("Cancelled before response creation.");
      expect(parseSent(socket).filter((event) => event.type === "response.cancel")).toEqual([]);
      expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
        replaceOnClear ? 1 : 0,
      );
      if (replaceOnClear) {
        bridge.sendUserMessage?.("Queued behind the replacement.");
        expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
          1,
        );
        emitServerEvent(socket, {
          type: "response.done",
          response: { id: "replacement", status: "completed", output: [] },
        });
        expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
          2,
        );
      } else {
        expect(
          parseSent(socket).at(-1)?.session?.audio?.input?.turn_detection?.create_response,
        ).toBe(true);
        bridge.sendUserMessage?.("Follow-up without a native terminal for the unsent response.");
        expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
          1,
        );
      }
      bridge.close();
    },
  );
  it("finishes history truncation and sink clearing before a truncate observer's replacement response", async () => {
    const trace: string[] = [];
    const bridge = createNativeBridge({
      autoRespondToAudio: false,
      getPlaybackState: () => [{ itemId: "completed-a", audioEndMs: 500 }],
      onClearAudio: () => {
        trace.push("sink.clear");
      },
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "conversation.item.truncate") {
          bridge.sendUserMessage?.("Replacement B.");
        }
      },
    });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "a" } });
    emitServerEvent(socket, {
      type: "response.done",
      response: { id: "a", status: "completed", output: [] },
    });
    vi.spyOn(socket, "send").mockImplementation((payload: string) => {
      socket.sent.push(payload);
      const event = JSON.parse(payload) as { type: string };
      if (event.type !== "conversation.item.create") {
        trace.push(event.type);
      }
    });
    bridge.handleBargeIn?.({ force: true });
    expect(trace).toEqual(["conversation.item.truncate", "sink.clear", "response.create"]);
    bridge.close();
  });
  it("does not drain a replacement when preparing-response cleanup throws", async () => {
    let cancelSuppression = false;
    const bridge = createNativeBridge({
      onClearAudio: () => {
        bridge.sendUserMessage?.("Queued replacement.");
        throw new Error("sink clear failed");
      },
      onEvent: (event) => {
        if (cancelSuppression && event.direction === "client" && event.type === "session.update") {
          cancelSuppression = false;
          bridge.handleBargeIn?.({ force: true });
        }
      },
    });
    const socket = await connectReadyBridge(bridge);
    cancelSuppression = true;
    expect(() => bridge.sendUserMessage?.("Cancelled preparation.")).toThrow("sink clear failed");
    expect(parseSent(socket).filter((event) => event.type.startsWith("response."))).toEqual([]);
    bridge.sendUserMessage?.("Explicit follow-up after the failed clear.");
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
    bridge.close();
  });
});
