// Control UI tests cover realtime talk google live behavior.
import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  audioContexts,
  beginTransport,
  createClient,
  createdSources,
  createSession,
  createTransport,
  encodeJsonFrame,
  flushMicrotasks,
  getGoogleLiveToolOwnerState,
  googleLiveTestFixture,
  inputProcessors,
  inputSinks,
  installGoogleLiveTestFixture,
  latestWebSocket,
  pumpMicrophone,
  requireFirstTalkEvent,
  startTransport,
  wsInstances,
} from "./realtime-talk-google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./realtime-talk-shared.ts";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

describe("GoogleLiveRealtimeTalkTransport", () => {
  installGoogleLiveTestFixture();

  it("connects only to the allowlisted endpoint with the ephemeral token", async () => {
    const transport = new GoogleLiveRealtimeTalkTransport(
      createSession(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?ignored=1",
      ),
      { callbacks: {}, client: createClient(), sessionKey: "main" },
    );

    const { start } = await beginTransport(transport);

    expect(latestWebSocket().url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-session",
    );
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
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

    const { start } = await beginTransport(transport);

    expect(googleLiveTestFixture.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "usb-mic" },
      },
    });
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
  });

  it("keeps the microphone processor inaudible locally", async () => {
    const transport = createTransport();

    await startTransport(transport);

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
    googleLiveTestFixture.getUserMedia.mockReturnValue(pendingMedia);
    const stopTrack = vi.fn();
    const onInputLevel = vi.fn();
    const transport = createTransport({ onInputLevel });

    const start = transport.start();
    transport.stop();
    resolveMedia({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await expect(start).resolves.toBe("cancelled");

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(inputProcessors).toHaveLength(0);
    expect(wsInstances).toHaveLength(0);
    expect(onInputLevel).not.toHaveBeenCalled();
  });

  it("requests ArrayBuffer frames and decodes binary setup messages", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });

    const { start, ws } = await beginTransport(transport);
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));
    await expect(start).resolves.toBe("ready");

    expect(ws.binaryType).toBe("arraybuffer");
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    transport.activate();
    transport.activate();
    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onStatus).toHaveBeenCalledOnce();
    const readyEvent = requireFirstTalkEvent(onTalkEvent);
    expect(readyEvent.type).toBe("session.ready");
    expect(readyEvent.sessionId).toBe("main:google:provider-websocket");
    expect(readyEvent.transport).toBe("provider-websocket");
  });

  it("releases owned media when the live socket closes", async () => {
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const transport = createTransport({ onStatus, onTranscript });

    const ws = await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    ws.emitClose();

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime connection closed");
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(2);
    for (const context of audioContexts) {
      expect(context.close).toHaveBeenCalledOnce();
    }

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "too late", finished: true },
        },
      }),
    );
    await flushMicrotasks();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("preserves socket error precedence and ignores the later close", async () => {
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const transport = createTransport({ onStatus, onTranscript });

    const ws = await startTransport(transport);
    onStatus.mockClear();
    ws.emitError();
    ws.emitClose();

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime connection failed");
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "too late", finished: true },
        },
      }),
    );
    await flushMicrotasks();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it.each(["status", "talk event"] as const)(
    "releases socket resources when the terminal %s callback throws",
    async (callbackKind) => {
      const transport = createTransport(
        callbackKind === "status"
          ? {
              onStatus: vi.fn((status) => {
                if (status === "error") {
                  throw new Error("consumer failed");
                }
              }),
            }
          : {
              onTalkEvent: vi.fn((event) => {
                if (event.type === "session.closed") {
                  throw new Error("consumer failed");
                }
              }),
            },
      );

      const ws = await startTransport(transport);
      expect(() => ws.emitError()).toThrow("consumer failed");

      expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
      expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
      for (const context of audioContexts) {
        expect(context.close).toHaveBeenCalledOnce();
      }
      ws.emitClose();
    },
  );

  it("finishes cleanup when the input-level callback throws during activation", async () => {
    const onInputLevel = vi.fn(() => {
      throw new Error("meter callback failed");
    });
    const transport = createTransport({ onInputLevel });
    const { start, ws } = await beginTransport(transport);
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("meter callback failed");
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(inputProcessors).toHaveLength(0);
    expect(ws.readyState).toBe(3);
    for (const context of audioContexts) {
      expect(context.close).toHaveBeenCalledOnce();
    }
  });

  it("reports microphone activity and resets it when stopped", async () => {
    const onInputLevel = vi.fn();
    const transport = createTransport({ onInputLevel });

    await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096).fill(0.25));
    transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

  it("decodes Blob setup messages", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    const { start, ws } = await beginTransport(transport);
    ws.emitOpen();
    ws.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));
    await expect(start).resolves.toBe("ready");
    transport.activate();

    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
  });

  it("stops queued output when Google Live sends interruption", async () => {
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent });
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await waitForFast(() => expect(createdSources).toHaveLength(1));

    const source = createdSources[0];
    ws.emitMessage(encodeJsonFrame({ serverContent: { interrupted: true } }));

    await waitForFast(() => expect(source?.stop).toHaveBeenCalledTimes(1));
    const cancelledEvent = onTalkEvent.mock.calls.find(
      ([event]) => event.type === "turn.cancelled",
    )?.[0];
    expect(cancelledEvent?.final).toBe(true);
    expect(cancelledEvent?.payload).toStrictEqual({ reason: "provider-interrupted" });
  });

  it("closes an overflowing playback response and ignores late provider audio", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: Array.from({ length: 321 }, () => ({
              inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" },
            })),
          },
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime Talk playback exceeded the browser audio buffer limit",
      ),
    );
    expect(createdSources).toHaveLength(320);
    expect(createdSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    expect(ws.readyState).toBe(3);
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          event.type === "turn.cancelled" &&
          event.final === true &&
          event.payload?.reason === "playback-overflow",
      ),
    ).toBe(true);

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await flushMicrotasks();
    expect(createdSources).toHaveLength(320);
  });

  it("rejects an oversized first frame before decoding provider audio", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  data: "!".repeat(700_000),
                  mimeType: "audio/pcm;rate=24000",
                },
              },
            ],
          },
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime Talk playback exceeded the browser audio buffer limit",
      ),
    );
    expect(createdSources).toHaveLength(0);
    expect(ws.readyState).toBe(3);
  });

  it("emits common Talk events for Google Live transcript and audio frames", async () => {
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent, onTranscript });

    const ws = await startTransport(transport);
    onTalkEvent.mockClear();
    ws.emitMessage(
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

    await waitForFast(() =>
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

  it("stops processing the current provider message when a transcript callback closes it", async () => {
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const transport = createTransport({ onTalkEvent, onTranscript });

    const ws = await startTransport(transport);
    onTalkEvent.mockClear();
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "overflow", finished: true },
          outputTranscription: { text: "too late", finished: true },
          turnComplete: true,
        },
      }),
    );
    await flushMicrotasks();

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });

  it("silently disposes a provisional Google Live transport", async () => {
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent });
    const { start, ws } = await beginTransport(transport);

    transport.stop({ emitClosed: false });
    await expect(start).resolves.toBe("cancelled");

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(3);
  });

  it("ignores late WebSocket events after stop", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    const { start, ws } = await beginTransport(transport);

    transport.stop();
    await expect(start).resolves.toBe("cancelled");
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
    const ws = await startTransport(transport);
    onStatus.mockClear();

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
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("thinking", undefined));
    await waitForFast(() => expect(listeners.size).toBe(1));

    transport.stop();
    for (const listener of listeners) {
      listener({ event: "chat", payload: { runId, state: "final", message: { text: "done" } } });
    }

    await waitForFast(() => {
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
    const ws = await startTransport(transport);

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
    await waitForFast(() => expect(listeners.size).toBe(1));
    for (const listener of listeners) {
      listener({
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "done" } },
      });
    }

    await waitForFast(() =>
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

  it("does not retain browser tool arguments while a consult is pending", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockResolvedValue({ runId: "run-1" });
    const transport = createTransport({}, client);
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { prompt: "x".repeat(64 * 1024) },
            },
          ],
        },
      }),
    );

    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-1")).toStrictEqual({
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        cancelled: false,
      }),
    );
    transport.stop();
  });

  it("answers unsupported browser tools once without retaining them", async () => {
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent });
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: { value: 1 } }],
        },
      }),
    );

    await waitForFast(() =>
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-unknown",
              name: "unknown_tool",
              response: { error: 'Tool "unknown_tool" is not available in browser Talk' },
            },
          ],
        },
      }),
    );
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.size).toBe(0);
    expect(onTalkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.error",
        callId: "call-unknown",
        final: true,
      }),
    );
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: { value: 2 } }],
        },
      }),
    );
    await flushMicrotasks();
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-unknown"),
    ).toHaveLength(1);
    transport.stop();
  });

  it("fails closed when an unsupported browser tool response cannot be sent", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    const ws = await startTransport(transport);
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("Google Live socket rejected the unsupported tool result");
    });

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: { value: 1 } }],
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Google Live socket rejected the unsupported tool result",
      ),
    );
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-unknown")).toBe(false);
    expect(ws.readyState).toBe(3);
  });

  it("aborts only the browser consult cancelled by Google", async () => {
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      expect(method).toBe("talk.client.toolCall");
      return { runId: `run-${String(params.callId)}` };
    });
    const client = {
      addEventListener: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus }, client);
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "first" },
            },
            {
              id: "call-2",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "second" },
            },
          ],
        },
      }),
    );
    await waitForFast(() => expect(listeners.size).toBe(2));
    onStatus.mockClear();

    ws.emitMessage(
      encodeJsonFrame({
        toolCallCancellation: { ids: ["call-1"] },
      }),
    );

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "main",
        runId: "run-call-1",
      }),
    );
    expect(client["request"]).not.toHaveBeenCalledWith("chat.abort", {
      sessionKey: "main",
      runId: "run-call-2",
    });
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-1")).toBe(false),
    );
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .some((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-1"),
    ).toBe(false);
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    ws.emitMessage(
      encodeJsonFrame({
        toolCallCancellation: { ids: ["call-2"] },
      }),
    );
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "main",
        runId: "run-call-2",
      }),
    );
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    transport.stop();
  });

  it("aborts an initial consult request and ignores a replay of its cancelled call id", async () => {
    let resolveToolCall: (value: { runId: string }) => void = () => undefined;
    const pendingToolCall = new Promise<{ runId: string }>((resolve) => {
      resolveToolCall = resolve;
    });
    const request = vi.fn((method: string): Promise<unknown> => {
      if (method === "talk.client.toolCall") {
        return pendingToolCall;
      }
      expect(method).toBe("chat.abort");
      return Promise.resolve({ ok: true, aborted: true });
    });
    const client = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = createTransport({}, client);
    const ws = await startTransport(transport);
    const toolCall = {
      id: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "check the session" },
    };

    ws.emitMessage(encodeJsonFrame({ toolCall: { functionCalls: [toolCall] } }));
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    ws.emitMessage(encodeJsonFrame({ toolCallCancellation: { ids: ["call-1"] } }));
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-1")?.cancelled).toBe(
        true,
      ),
    );
    resolveToolCall({ runId: "run-1" });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "main",
        runId: "run-1",
      }),
    );
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-1")).toBe(false),
    );

    ws.emitMessage(encodeJsonFrame({ toolCall: { functionCalls: [toolCall] } }));
    await flushMicrotasks();
    expect(request.mock.calls.filter(([method]) => method === "talk.client.toolCall")).toHaveLength(
      1,
    );
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .some((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-1"),
    ).toBe(false);
    transport.stop();
  });

  it("aborts browser control requests without emitting a false terminal outcome", async () => {
    let resolveControl: (value: { ok: boolean; mode: string }) => void = () => undefined;
    const pendingControl = new Promise<{ ok: boolean; mode: string }>((resolve) => {
      resolveControl = resolve;
    });
    const request = vi.fn((method: string): Promise<unknown> => {
      expect(method).toBe("talk.client.steer");
      return pendingControl;
    });
    const client = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent }, client);
    const ws = await startTransport(transport);

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
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    ws.emitMessage(encodeJsonFrame({ toolCallCancellation: { ids: ["call-control"] } }));
    await waitForFast(() =>
      expect(
        getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-control")?.cancelled,
      ).toBe(true),
    );
    resolveControl({ ok: true, mode: "status" });
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-control")).toBe(false),
    );

    expect(
      onTalkEvent.mock.calls.some(
        ([event]) => event.type === "tool.progress" || event.type === "tool.error",
      ),
    ).toBe(false);
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .some((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-control"),
    ).toBe(false);
    transport.stop();
  });

  it("fails closed when browser Google exceeds the pending tool-call limit", async () => {
    const onStatus = vi.fn();
    const request = vi.fn();
    const client = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = createTransport({ onStatus }, client);
    const ws = await startTransport(transport);
    const { pendingCalls } = getGoogleLiveToolOwnerState(transport);
    for (let index = 0; index < 1_024; index += 1) {
      pendingCalls.set(`existing-${index}`, { name: "lookup", cancelled: false });
    }

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "overflow",
              name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
              args: {},
            },
            {
              id: "after-overflow",
              name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
              args: { text: "must not run", mode: "status" },
            },
          ],
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Google Live pending tool-call limit exceeded",
      ),
    );
    expect(ws.readyState).toBe(3);
    expect(pendingCalls.size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed before evicting seen browser tool-call ids", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    const ws = await startTransport(transport);
    const internal = getGoogleLiveToolOwnerState(transport);

    for (let index = 0; index < 1_024; index += 1) {
      internal.seenCallIds.add(`call-${index}`);
    }
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "overflow", name: "unknown_tool", args: {} }],
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Google Live tool-call session limit exceeded",
      ),
    );
    expect(ws.readyState).toBe(3);
    expect(internal.seenCallIds.size).toBe(0);
  });
});
