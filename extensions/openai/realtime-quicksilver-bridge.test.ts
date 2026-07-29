import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import type {
  OpenAIQuicksilverSocket,
  OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(payload: string): void {
    this.sent.push(payload);
    const event = JSON.parse(payload) as { type?: string };
    if (event.type === "session.update") {
      queueMicrotask(() =>
        this.serverEvent({
          type: "session.started",
          session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
        }),
      );
    }
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }

  serverEvent(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
}

function createHarness(params?: { audioFormat?: "pcm16" | "g711_ulaw" }) {
  const socket = new FakeSocket();
  const connections: Array<{ url: string; options: ClientOptions }> = [];
  const webSocketFactory: OpenAIQuicksilverSocketFactory = (url, options) => {
    connections.push({ url, options });
    queueMicrotask(() => socket.open());
    return socket as unknown as OpenAIQuicksilverSocket;
  };
  const onAudio = vi.fn();
  const onTranscript = vi.fn();
  const onToolCall = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  const onClose = vi.fn();
  const onEvent = vi.fn();
  const bridge = new OpenAIQuicksilverVoiceBridge({
    providerConfig: {},
    model: "gpt-live-1-codex",
    voice: "marin",
    instructions: "Use delegation for real work.",
    audioFormat:
      params?.audioFormat === "g711_ulaw"
        ? { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }
        : { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
    resolveAuth: async () => ({ type: "api-key", token: "test-key" }),
    webSocketFactory,
    onAudio,
    onClearAudio: vi.fn(),
    onTranscript,
    onToolCall,
    onReady,
    onError,
    onClose,
    onEvent,
  });
  return {
    bridge,
    connections,
    onAudio,
    onClose,
    onError,
    onEvent,
    onReady,
    onToolCall,
    onTranscript,
    socket,
  };
}

function sentEvents(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("OpenAIQuicksilverVoiceBridge", () => {
  it("connects directly to /v1/live and completes the Frameless Bidi handshake", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]?.url).toBe("wss://api.openai.com/v1/live?model=gpt-live-1-codex");
    expect(harness.connections[0]?.options.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "OpenAI-Alpha": "quicksilver=v2",
    });
    expect(sentEvents(harness.socket)[0]).toEqual({
      type: "session.update",
      session: {
        instructions: "Use delegation for real work.",
        audio: { output: { voice: "marin" } },
        delegation: { type: "client" },
      },
    });
    expect(harness.bridge.isConnected()).toBe(true);
    expect(harness.bridge.handlesInputAudioBargeIn).toBe(false);
    expect(harness.onReady).toHaveBeenCalledOnce();

    harness.bridge.close();
    await vi.waitFor(() => expect(harness.onClose).toHaveBeenCalledWith("completed"));
  });

  it("maps audio, transcripts, and delegations onto the shared bridge contract", async () => {
    const harness = createHarness();
    await harness.bridge.connect();
    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    harness.socket.serverEvent({
      type: "input_transcript.added",
      item: { text: "hello" },
    });
    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "hello there" },
    });
    harness.socket.serverEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "check the repository" }],
      },
    });

    expect(harness.onAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    expect(harness.onTranscript).toHaveBeenNthCalledWith(1, "user", "hello", false);
    expect(harness.onTranscript).toHaveBeenNthCalledWith(2, "user", "hello there", true);
    expect(harness.onToolCall).toHaveBeenCalledWith({
      itemId: "delegation-1",
      callId: "delegation-1",
      name: "openclaw_agent_consult",
      args: { question: "check the repository" },
    });

    harness.bridge.submitToolResult("delegation-1", { text: "The repository is clean." });
    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "The repository is clean." }],
    });
  });

  it("normalizes assistant completion to the shared response lifecycle", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "hello" },
    });
    expect(harness.onEvent).toHaveBeenLastCalledWith({
      direction: "server",
      type: "turn.done",
    });

    harness.socket.serverEvent({
      type: "turn.done",
      turn: { role: "assistant", transcript: "hi there" },
    });
    expect(harness.onEvent).toHaveBeenLastCalledWith({
      direction: "server",
      type: "response.done",
    });
  });

  it("converts telephony mu-law audio to and from GPT-Live PCM16", async () => {
    const harness = createHarness({ audioFormat: "g711_ulaw" });
    await harness.bridge.connect();
    harness.bridge.sendAudio(Buffer.alloc(160, 0xff));

    const inputEvent = sentEvents(harness.socket).at(-1);
    expect(inputEvent?.type).toBe("input_audio.append");
    expect(Buffer.from(String(inputEvent?.audio), "base64")).toHaveLength(960);

    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.alloc(960).toString("base64"),
    });
    expect(harness.onAudio).toHaveBeenCalledWith(Buffer.alloc(160, 0xff));
  });

  it("uses session context for forced consult results without a provider delegation", async () => {
    const harness = createHarness();
    await harness.bridge.connect();
    harness.bridge.submitToolResult("forced-consult", { text: "Forced answer" });

    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Forced answer" }],
    });

    harness.bridge.triggerGreeting();
    expect(sentEvents(harness.socket).at(-1)).toEqual({
      type: "session.context.append",
      channel: "speakable",
      content: [{ type: "input_text", text: "Greet the user briefly." }],
    });
  });
});
