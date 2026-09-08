import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    constructor() {
      super();
      MockWebSocket.instances.push(this);
    }
    send(payload: string) {
      this.sent.push(payload);
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.from(""));
    }
  }
  return { FakeWebSocket: MockWebSocket };
});
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));

beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("sends xAI creation before its observer can cancel and releases the next turn", async () => {
  const onAudio = vi.fn();
  let cancelled = false;
  const bridge: RealtimeVoiceBridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
    onAudio,
    onClearAudio: vi.fn(),
    onEvent: (event) => {
      if (event.direction === "client" && event.type === "response.create" && !cancelled) {
        cancelled = true;
        bridge.handleBargeIn?.({ force: true });
      }
    },
  });
  const connecting = bridge.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  const emit = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)));
  const sent = () => socket.sent.map((payload) => JSON.parse(payload) as { type: string });
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emit({ type: "session.updated" });
  await connecting;
  bridge.sendUserMessage?.("First response.");
  expect(
    sent()
      .filter((event) => event.type.startsWith("response."))
      .map((event) => event.type),
  ).toEqual(["response.create", "response.cancel"]);
  emit({ type: "response.created", response: { id: "cancelled" } });
  emit({
    type: "response.output_audio.delta",
    item_id: "discarded",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).not.toHaveBeenCalled();
  bridge.sendUserMessage?.("Follow-up response.");
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(1);
  emit({ type: "response.done", response: { id: "cancelled", status: "cancelled", output: [] } });
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(2);
  emit({ type: "response.created", response: { id: "recovery" } });
  emit({
    type: "response.output_audio.delta",
    item_id: "heard",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).toHaveBeenCalledTimes(1);
  bridge.close();
});

it.each([
  { requestOn: "response.cancel", serverVad: false },
  { requestOn: "conversation.item.truncate", serverVad: false },
  { requestOn: "conversation.item.truncate", serverVad: true },
])(
  "finishes interruption before a $requestOn observer requests the next xAI response (server VAD=$serverVad)",
  async ({ requestOn, serverVad }) => {
    const trace: string[] = [];
    const acknowledgments: Array<() => void> = [];
    let playback = [{ itemId: "completed-a", audioEndMs: 500 }];
    const bridge = buildXaiRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
      onAudio: vi.fn(),
      getPlaybackState: () => playback,
      onMark: (_name, acknowledge) => {
        if (acknowledge) {
          acknowledgments.push(acknowledge);
        }
      },
      onClearAudio: () => {
        playback = [];
        trace.push("sink.clear");
      },
      onEvent: (event) => {
        if (event.direction === "client" && event.type === requestOn) {
          bridge.sendUserMessage?.("Replacement B.");
        }
      },
    });
    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    const emit = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)));
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    emit({ type: "session.updated" });
    await connecting;
    emit({ type: "response.created", response: { id: "a" } });
    emit({
      type: "response.output_audio.delta",
      item_id: "completed-a",
      delta: Buffer.alloc(8_000).toString("base64"),
    });
    emit({ type: "response.done", response: { id: "a", status: "completed", output: [] } });
    vi.spyOn(socket, "send").mockImplementation((payload: string) => {
      socket.sent.push(payload);
      const event = JSON.parse(payload) as { type: string };
      if (event.type !== "conversation.item.create") {
        trace.push(event.type);
      }
    });
    if (serverVad) {
      emit({ type: "input_audio_buffer.speech_started" });
      expect(trace).toEqual(["conversation.item.truncate", "sink.clear"]);
      // The explicit host request remains pending; native VAD does not prove its
      // input was included. Release that request after the automatic response drains.
      emit({ type: "response.created", response: { id: "automatic-vad" } });
      emit({
        type: "response.output_audio.delta",
        item_id: "vad-audio",
        delta: Buffer.alloc(320).toString("base64"),
      });
      emit({
        type: "response.done",
        response: { id: "automatic-vad", status: "completed", output: [] },
      });
      expect(trace).toEqual(["conversation.item.truncate", "sink.clear"]);
      acknowledgments.at(-1)?.();
      acknowledgments.at(-1)?.();
      expect(trace).toEqual(["conversation.item.truncate", "sink.clear", "response.create"]);
    } else {
      bridge.handleBargeIn?.({ force: true });
      expect(trace).toEqual([
        "response.cancel",
        "conversation.item.truncate",
        "sink.clear",
        "response.create",
      ]);
    }
    bridge.close();
  },
);

it("does not drain a replacement when a completed-playback cancellation observer throws", async () => {
  let failObserver = true;
  const onClearAudio = vi.fn();
  const bridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
    onAudio: vi.fn(),
    getPlaybackState: () => [{ itemId: "completed-a", audioEndMs: 500 }],
    onClearAudio,
    onEvent: (event) => {
      if (failObserver && event.direction === "client" && event.type === "response.cancel") {
        failObserver = false;
        bridge.sendUserMessage?.("Queued replacement B.");
        throw new Error("cancel observer failed");
      }
    },
  });
  const connecting = bridge.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  const emit = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)));
  const sent = () => socket.sent.map((payload) => JSON.parse(payload) as { type: string });
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emit({ type: "session.updated" });
  await connecting;
  emit({ type: "response.created", response: { id: "a" } });
  emit({ type: "response.done", response: { id: "a", status: "completed", output: [] } });
  expect(() => bridge.handleBargeIn?.({ force: true })).toThrow("cancel observer failed");
  expect(sent().filter((event) => event.type === "response.create")).toEqual([]);
  expect(onClearAudio).not.toHaveBeenCalled();
  bridge.handleBargeIn?.({ force: true });
  expect(onClearAudio).toHaveBeenCalledOnce();
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(1);
  bridge.close();
});
