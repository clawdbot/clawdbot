import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    closed = false;

    constructor() {
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

    send(): void {}

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;

async function waitForFakeSocket(index = 0): Promise<FakeWebSocketInstance> {
  let socket: FakeWebSocketInstance | undefined;
  await vi.waitFor(() => {
    socket = FakeWebSocket.instances[index];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }
  });
  if (!socket) {
    throw new Error("expected session to create a websocket");
  }
  return socket;
}

function emitJson(socket: FakeWebSocketInstance, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

async function connectFakeSession(
  session: { connect(): Promise<void> },
  socketIndex = 0,
): Promise<FakeWebSocketInstance> {
  const connecting = session.connect();
  const socket = await waitForFakeSocket(socketIndex);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emitJson(socket, { type: "session.updated" });
  await connecting;
  return socket;
}

describe("OpenAI realtime transcription terminal history bounds", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: "without item identity", itemId: undefined, committed: false },
    { label: "before item commit", itemId: "uncommitted-item", committed: false },
    { label: "after item commit", itemId: "committed-item", committed: true },
  ])("rejects an oversized final transcript $label", async ({ itemId, committed }) => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    if (committed) {
      emitJson(socket, {
        type: "input_audio_buffer.committed",
        item_id: itemId,
        previous_item_id: null,
      });
    }

    const transcript = `${"🙂".repeat((256 * 1024) / 4)}x`;
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript: "late transcript",
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    expect(socket.closed).toBe(true);
    session.close();
  });

  it("accepts an exact-limit UTF-8 final after releasing its own partial", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onPartial,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const transcript = "🙂".repeat((256 * 1024) / 4);
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "uncommitted-item",
      delta: transcript,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "uncommitted-item",
      transcript,
    });

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("counts retained sibling text when admitting a final transcript", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const partial = "🙂".repeat((128 * 1024) / 4);
    for (const itemId of ["retained-item", "completing-item"]) {
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.delta",
        item_id: itemId,
        delta: partial,
      });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "completing-item",
      transcript: `${partial}x`,
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });

  it("does not re-admit a terminal item after the settled frontier fills", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const transcripts: string[] = [];
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onPartial,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "oldest",
      transcript: "first",
    });
    for (let index = 0; index < 4095; index += 1) {
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `settled-${index}`,
        transcript: "",
      });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "oldest",
      transcript: "duplicate",
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "oldest",
      delta: "late partial",
    });

    expect(transcripts).toEqual(["first"]);
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("fails visibly instead of evicting terminal item history", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 4096; index += 1) {
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `settled-${index}`,
        transcript: "",
      });
    }
    emitJson(socket, {
      type: "input_audio_buffer.committed",
      item_id: "overflow-item",
      previous_item_id: null,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "overflow-item",
      error: { message: "provider failure" },
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the terminal item history limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);

    const reconnecting = session.connect();
    const replacementSocket = await waitForFakeSocket(1);
    replacementSocket.readyState = FakeWebSocket.OPEN;
    replacementSocket.emit("open");
    emitJson(replacementSocket, { type: "session.updated" });
    await reconnecting;
    emitJson(replacementSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "replacement-item",
      transcript: "replacement transcript",
    });

    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("replacement transcript");
    expect(onError).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("fails visibly when terminal item identities exceed 256 KiB", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "sk-test" }, // pragma: allowlist secret
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 256; index += 1) {
      emitJson(socket, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `${index.toString().padStart(4, "0")}${"i".repeat(1020)}`,
        transcript: "",
      });
    }
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "overflow-item",
      transcript: "must not emit",
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the terminal item history limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });
});
