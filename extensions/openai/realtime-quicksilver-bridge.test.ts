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
  closeCalls = 0;
  deferClose = false;

  open(): void {
    this.readyState = 1;
    this.emit("open");
    this.afterOpen?.(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
    const event = JSON.parse(payload) as { type?: string };
    if (event.type === "session.update" && this.autoStart) {
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
    this.closeCalls += 1;
    if (this.deferClose) {
      return;
    }
    this.finishClose();
  }

  finishClose(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }

  serverEvent(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  constructor(
    private readonly autoStart = true,
    private readonly afterOpen?: (socket: FakeSocket) => void,
  ) {
    super();
  }
}

function createHarness(params?: {
  audioFormat?: "pcm16" | "g711_ulaw";
  autoStart?: boolean;
  deferClose?: boolean;
  afterOpen?: (socket: FakeSocket) => void;
  resolveAuth?: () => Promise<{ type: "api-key"; token: string }>;
}) {
  const socket = new FakeSocket(params?.autoStart, params?.afterOpen);
  socket.deferClose = params?.deferClose ?? false;
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
    resolveAuth: params?.resolveAuth ?? (async () => ({ type: "api-key", token: "test-key" })),
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

  it("keeps repeated close idempotent while the transport is still open", async () => {
    const harness = createHarness({ deferClose: true });
    await harness.bridge.connect();

    harness.bridge.close();
    harness.bridge.close();

    expect(
      sentEvents(harness.socket).filter((event) => event.type === "session.close"),
    ).toHaveLength(1);
    expect(harness.socket.closeCalls).toBe(1);
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");

    harness.socket.finishClose();
    await Promise.resolve();
    expect(harness.onClose).toHaveBeenCalledOnce();
  });

  it("shares an in-flight connection until session readiness", async () => {
    const harness = createHarness({ autoStart: false });
    const firstConnect = harness.bridge.connect();
    const secondConnect = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    expect(harness.connections).toHaveLength(1);
    harness.socket.serverEvent({
      type: "session.started",
      session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });

    await Promise.all([firstConnect, secondConnect]);
    expect(harness.onReady).toHaveBeenCalledOnce();
  });

  it("bounds queued audio by aggregate bytes before session readiness", async () => {
    const harness = createHarness({ autoStart: false });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    harness.bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
    harness.bridge.sendAudio(Buffer.from("overflow"));
    harness.socket.serverEvent({
      type: "session.started",
      session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await connecting;

    const audioEvents = sentEvents(harness.socket).filter(
      (event) => event.type === "input_audio.append",
    );
    expect(audioEvents).toHaveLength(2);
    expect(
      audioEvents.map((event) => Buffer.from(String(event.audio), "base64").byteLength),
    ).toEqual([512 * 1024, 512 * 1024]);
    harness.bridge.close();
  });

  it("discards audio closed before the first connection and reconnects fresh", async () => {
    const harness = createHarness();

    harness.bridge.sendAudio(Buffer.from("queued-before-connect"));
    harness.bridge.close();
    harness.bridge.close();
    harness.bridge.sendAudio(Buffer.from("sent-after-close"));

    expect(harness.connections).toHaveLength(0);
    expect(harness.onClose).not.toHaveBeenCalled();

    await harness.bridge.connect();

    expect(
      sentEvents(harness.socket).filter((event) => event.type === "input_audio.append"),
    ).toHaveLength(0);

    harness.bridge.close();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");
  });

  it("does not carry queued audio across terminal close and explicit reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const bridge = new OpenAIQuicksilverVoiceBridge({
      providerConfig: {},
      model: "gpt-live-1-codex",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      resolveAuth: async () => ({ type: "api-key", token: "test-key" }),
      webSocketFactory: (_url, _options) => {
        const socket = new FakeSocket(false);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket as unknown as OpenAIQuicksilverSocket;
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const firstConnect = bridge.connect();
    await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(1));
    bridge.sendAudio(Buffer.from("queued-before-close"));
    bridge.close();
    await firstConnect;
    bridge.sendAudio(Buffer.from("sent-after-close"));

    const reconnecting = bridge.connect();
    await vi.waitFor(() => expect(sockets[1]?.readyState).toBe(1));
    sockets[1]?.serverEvent({
      type: "session.started",
      session: { id: "live-2", expires_at: Math.floor(Date.now() / 1000) + 60 },
    });
    await reconnecting;

    const secondSocket = sockets[1];
    if (!secondSocket) {
      throw new Error("expected bridge to reconnect");
    }
    expect(
      sentEvents(secondSocket).filter((event) => event.type === "input_audio.append"),
    ).toHaveLength(0);
    bridge.close();
  });

  it("rejects startup failures without emitting terminal callbacks", async () => {
    const harness = createHarness({ autoStart: false });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    harness.socket.serverEvent({
      type: "error",
      error: { message: "invalid live session" },
    });

    await expect(connecting).rejects.toThrow("invalid live session");
    expect(harness.onError).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
    expect(harness.bridge.isConnected()).toBe(false);
  });

  it("does not reject after explicit close while awaiting session readiness", async () => {
    const harness = createHarness({ autoStart: false, deferClose: true });
    const connecting = harness.bridge.connect();
    await vi.waitFor(() => expect(harness.socket.readyState).toBe(1));

    harness.bridge.close();
    harness.socket.emit("error", new Error("late startup error"));

    await expect(connecting).resolves.toBeUndefined();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");
    expect(harness.onError).not.toHaveBeenCalled();
    harness.socket.finishClose();
  });

  it("completes once when closed while authentication is pending", async () => {
    let resolveAuth!: (auth: { type: "api-key"; token: string }) => void;
    const harness = createHarness({
      resolveAuth: () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    });
    const connecting = harness.bridge.connect();

    harness.bridge.close();
    harness.bridge.close();
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("completed");

    resolveAuth({ type: "api-key", token: "test-key" });
    await expect(connecting).resolves.toBeUndefined();
    expect(harness.connections).toHaveLength(0);
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("reports a buffered terminal event that follows session readiness", async () => {
    const harness = createHarness({
      autoStart: false,
      afterOpen: (socket) => {
        socket.serverEvent({
          type: "session.started",
          session: { id: "live-1", expires_at: Math.floor(Date.now() / 1000) + 60 },
        });
        socket.finishClose();
      },
    });

    await harness.bridge.connect();

    expect(harness.onReady).toHaveBeenCalledOnce();
    expect(harness.onError).toHaveBeenCalledWith(
      new Error("GPT-Live WebSocket closed during startup"),
    );
    expect(harness.onClose).toHaveBeenCalledOnce();
    expect(harness.onClose).toHaveBeenCalledWith("error");
    expect(harness.bridge.isConnected()).toBe(false);
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

  it("bounds direct tool results before sideband sends", async () => {
    const harness = createHarness();
    await harness.bridge.connect();

    harness.socket.serverEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-large",
        content: [{ type: "input_text", text: "summarize everything" }],
      },
    });
    harness.bridge.submitToolResult("delegation-large", { text: "x".repeat(10_000) });

    const appends = sentEvents(harness.socket).filter(
      (event) => event.type === "delegation.context.append",
    );
    expect(appends.length).toBeGreaterThan(0);
    expect(appends.length).toBeLessThanOrEqual(11);
    expect(
      appends.map((event) => (event.content as Array<{ text: string }>)[0]?.text ?? "").join(""),
    ).toMatch(/^x+ \[truncated\]$/);
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
    expect(Buffer.from(String(inputEvent?.audio), "base64")).toHaveLength(870);

    harness.socket.serverEvent({
      type: "output_audio.delta",
      audio: Buffer.alloc(960).toString("base64"),
    });
    expect(harness.onAudio).toHaveBeenCalledWith(Buffer.alloc(155, 0xff));
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
