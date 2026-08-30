// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { prepareRealtimeTalkTestInput } from "./realtime-talk-input.test-support.ts";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

let getUserMedia: ReturnType<typeof vi.fn>;
let stopInputTrack: ReturnType<typeof vi.fn>;

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function requirePeer(): FakePeerConnection {
  const peer = FakePeerConnection.instances[0];
  if (!peer) {
    throw new Error("expected WebRTC peer");
  }
  return peer;
}

function requireTalkEvent(
  onTalkEvent: ReturnType<typeof vi.fn>,
  index: number,
): Record<string, unknown> {
  const call = onTalkEvent.mock.calls[index];
  if (!call) {
    throw new Error(`expected talk event at index ${index}`);
  }
  const [event] = call;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`expected talk event record at index ${index}`);
  }
  return event as Record<string, unknown>;
}

type SentRealtimeEvent = {
  type?: string;
  item?: {
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function stubAnswerSdpFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
}

function createPendingSdpResponse(signal: AbortSignal | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            const reason = signal?.reason;
            controller.error(reason instanceof Error ? reason : new Error("offer request aborted"));
          },
          { once: true },
        );
      },
    }),
  );
}

async function createOpenAiTransport(
  client: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
  inputDeviceId?: string,
): Promise<WebRtcSdpRealtimeTalkTransport> {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
      offerResponseMaxBytes: 256 * 1024,
    },
    {
      input: await prepareRealtimeTalkTestInput(inputDeviceId),
      client: client as never,
      sessionKey: "main",
      callbacks: callbacks as never,
    },
  );
}

function dispatchRealtimeEvent(peer: FakePeerConnection | undefined, event: unknown): void {
  peer?.channel.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify(event),
    }),
  );
}

function dispatchConsultToolCall(peer: FakePeerConnection | undefined): void {
  dispatchRealtimeEvent(peer, {
    type: "response.done",
    response: {
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "item-1",
          status: "completed",
          call_id: "call-1",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          arguments: JSON.stringify({ question: "status?" }),
        },
      ],
    },
  });
}

function dispatchTranscription(peer: FakePeerConnection | undefined, transcript: string): void {
  dispatchRealtimeEvent(peer, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript,
  });
}

async function startActiveConsult(
  request: ReturnType<typeof vi.fn>,
  options: { responseAlreadyActive?: boolean } = {},
): Promise<{ transport: WebRtcSdpRealtimeTalkTransport; peer: FakePeerConnection | undefined }> {
  const transport = await createOpenAiTransport({
    addEventListener: vi.fn(() => () => undefined),
    request,
  });

  await transport.start();
  const peer = FakePeerConnection.instances[0];
  dispatchConsultToolCall(peer);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
  );
  if (options.responseAlreadyActive) {
    dispatchRealtimeEvent(peer, { type: "response.created" });
  }

  return { transport, peer };
}

function sentRealtimeEvents(peer: FakePeerConnection | undefined): SentRealtimeEvent[] {
  return (
    peer?.channel.send.mock.calls.map(
      ([payload]) => JSON.parse(String(payload)) as SentRealtimeEvent,
    ) ?? []
  );
}

function expectSpokenStatusMessage(events: SentRealtimeEvent[], message: string): void {
  expect(events).toContainEqual({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: expect.stringContaining(`Status: "${message}"`),
        },
      ],
    },
  });
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    FakePeerConnection.instances = [];
    stopInputTrack = vi.fn();
    const track = Object.assign(new EventTarget(), {
      stop: stopInputTrack,
    }) as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  it("reports microphone activity and resets it when stopped", async () => {
    stubAnswerSdpFetch();
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect: vi.fn(),
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
        };
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onInputLevel = vi.fn();
    const transport = await createOpenAiTransport({}, { onInputLevel });

    await transport.start();
    transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reclaims the input meter when its first level update stops the transport", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect: vi.fn(),
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
        };
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onInputLevel = vi.fn((level: number) => {
      if (level > 0) {
        transport.stop();
      }
    });
    const transport = await createOpenAiTransport({}, { onInputLevel });

    await expect(transport.start()).resolves.toBe("cancelled");
    transport.stop();
    transport.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses pending setup errors after stop", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    let rejectOffer: (error: Error) => void = () => undefined;
    const transport = await createOpenAiTransport();

    const createOfferSpy = vi.spyOn(FakePeerConnection.prototype, "createOffer").mockImplementation(
      () =>
        new Promise<RTCSessionDescriptionInit>((_, reject) => {
          rejectOffer = reject;
        }),
    );
    const startPromise = transport.start();
    await waitForFast(() => expect(createOfferSpy).toHaveBeenCalled());
    transport.stop();
    rejectOffer(new Error("closed peer rejected offer creation"));

    await expect(startPromise).resolves.toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends provider offer headers with the WebRTC SDP request", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerHeaders: {
          originator: "openclaw",
          version: "2026.3.22",
        },
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {} as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "offer-sdp",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        Authorization: "Bearer client-secret-123",
        "Content-Type": "application/sdp",
      },
      signal: expect.any(AbortSignal),
    });
    transport.stop();
  });

  it("aborts stalled WebRTC SDP answer body reads after the offer timeout", async () => {
    vi.useFakeTimers();
    let offerSignal: AbortSignal | undefined;
    let response: Response | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      offerSignal = init?.signal ?? undefined;
      response = createPendingSdpResponse(offerSignal);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = await createOpenAiTransport();

    const startResult = transport.start().then(
      () => undefined,
      (error: unknown) => error,
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(offerSignal?.aborted).toBe(false);
    expect(response?.body?.locked).toBe(true);

    await vi.runAllTimersAsync();

    await expect(startResult).resolves.toMatchObject(
      new Error("Realtime WebRTC offer request timed out after 30000ms"),
    );
    expect(offerSignal?.aborted).toBe(true);
    expect(response?.body?.locked).toBe(false);
  });

  it("aborts a pending WebRTC SDP answer body read when stopped", async () => {
    let offerSignal: AbortSignal | undefined;
    let response: Response | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      offerSignal = init?.signal ?? undefined;
      response = createPendingSdpResponse(offerSignal);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = await createOpenAiTransport();

    const startResult = transport.start();
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(response?.body?.locked).toBe(true);

    transport.stop();

    await expect(startResult).resolves.toBe("cancelled");
    expect(offerSignal?.aborted).toBe(true);
    expect(response?.body?.locked).toBe(false);
  });

  it("reports a closed candidate when the peer fails during final setup", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });
    const start = transport.start();
    const peer = requirePeer();
    let finishRemoteDescription: (() => void) | undefined;
    const remoteDescription = vi.spyOn(peer, "setRemoteDescription").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishRemoteDescription = resolve;
        }),
    );
    await waitForFast(() => expect(remoteDescription).toHaveBeenCalled());
    onStatus.mockClear();

    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));
    finishRemoteDescription?.();

    await expect(start).rejects.toThrow("Realtime connection closed");
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("releases an active peer when the terminal status callback throws", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus });
    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });
    const peer = requirePeer();

    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime connection closed");
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("releases an active peer when its closed-event callback throws", async () => {
    stubAnswerSdpFetch();
    const onTalkEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const transport = await createOpenAiTransport({}, { onTalkEvent });
    await expect(transport.start()).resolves.toBe("ready");
    const peer = requirePeer();

    expect(() => transport.stop()).toThrow("consumer failed");

    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("clears the WebRTC offer timeout after setup succeeds", async () => {
    vi.useFakeTimers();
    let offerSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        offerSignal = init?.signal ?? undefined;
        return new Response("answer-sdp");
      }) as unknown as typeof fetch,
    );
    const transport = await createOpenAiTransport();

    await transport.start();
    await vi.runAllTimersAsync();

    expect(offerSignal?.aborted).toBe(false);
    transport.stop();
  });

  it("surfaces realtime provider errors from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onStatus = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "error",
          error: { message: "Realtime model rejected the session" },
        }),
      }),
    );

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime model rejected the session");
    transport.stop();
  });

  it("surfaces speech and response lifecycle status from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {} as never,
        sessionKey: "main",
        callbacks: { onStatus, onTalkEvent },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const event of [
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      { type: "response.created", response: { id: "response-1" } },
      { type: "response.done", response: { id: "response-1", status: "completed" } },
    ]) {
      peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }

    expect(onStatus).toHaveBeenCalledWith("listening", "Speech detected");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Processing speech");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Generating response");
    expect(onStatus).toHaveBeenCalledWith("listening", undefined);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "turn.started",
      "input.audio.committed",
      "turn.ended",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-1",
    ]);
    transport.stop();
  });

  it.each([
    ["cancelled", "turn.cancelled"],
    ["failed", "turn.ended"],
    ["incomplete", "turn.ended"],
  ] as const)("keeps browser Talk reusable after a %s response", async (status, terminalType) => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });
    await transport.start();
    const peer = FakePeerConnection.instances[0];
    const response = {
      id: "response-1",
      status,
      ...(status === "failed"
        ? { status_details: { error: { code: "provider_error" } } }
        : status === "incomplete"
          ? { status_details: { reason: "max_output_tokens" } }
          : { status_details: { reason: "client_cancelled" } }),
    };
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-1" } });
    dispatchRealtimeEvent(peer, { type: "response.done", response });
    dispatchRealtimeEvent(peer, { type: "response.done", response });
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-2" } });
    dispatchRealtimeEvent(peer, {
      type: "response.done",
      response: { id: "response-2", status: "completed" },
    });

    const terminalEvents = onTalkEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "turn.ended" || event.type === "turn.cancelled");
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents[0]?.type).toBe(terminalType);
    expect(
      onTalkEvent.mock.calls
        .map(([event]) => event.type)
        .filter((type) => type === "session.error"),
    ).toHaveLength(status === "cancelled" ? 0 : 1);
    expect(onStatus).toHaveBeenLastCalledWith("listening", undefined);
    transport.stop();
  });

  it("emits common Talk transcript events from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {} as never,
        sessionKey: "main",
        callbacks: { onTranscript, onTalkEvent },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "input-1",
          transcript: "hello",
        }),
      }),
    );
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.audio_transcript.done",
          item_id: "response-1",
          transcript: "hi there",
        }),
      }),
    );

    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "assistant",
      text: "hi there",
      final: true,
    });
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "transcript.done",
      "output.text.done",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual(["turn-1", "turn-1"]);
    const userTranscriptEvent = requireTalkEvent(onTalkEvent, 0);
    expect(userTranscriptEvent.itemId).toBe("input-1");
    expect(userTranscriptEvent.payload).toEqual({ role: "user", text: "hello" });
    expect(userTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(userTranscriptEvent.transport).toBe("webrtc");
    const assistantTranscriptEvent = requireTalkEvent(onTalkEvent, 1);
    expect(assistantTranscriptEvent.itemId).toBe("response-1");
    expect(assistantTranscriptEvent.payload).toEqual({ text: "hi there" });
    expect(assistantTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(assistantTranscriptEvent.transport).toBe("webrtc");
    transport.stop();
  });

  it("stops processing the current provider event when a transcript callback closes it", async () => {
    stubAnswerSdpFetch();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const transport = await createOpenAiTransport({}, { onTranscript, onTalkEvent });

    await transport.start();
    dispatchTranscription(FakePeerConnection.instances[0], "overflow");

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });

  it("maps frameless Codex transcript events by role and finality", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {} as never,
        sessionKey: "main",
        callbacks: { onTalkEvent },
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const event of [
      { type: "input_transcript.added", item: { id: "user-live", text: "hel" } },
      { type: "output_transcript.added", item: { id: "assistant-live", text: "hi" } },
      {
        type: "turn.done",
        turn: { id: "user-final", role: "user", transcript: "hello" },
      },
      {
        type: "turn.done",
        turn: { id: "assistant-final", role: "assistant", transcript: "hi there" },
      },
    ]) {
      peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }

    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "transcript.delta",
      "output.text.delta",
      "transcript.done",
      "output.text.done",
      "turn.ended",
    ]);
    transport.stop();
  });

  // Audio output sends the final string in `transcript`; text output sends it in
  // `text`. Both must surface the same assistant transcript + talk events.
  it.each([
    {
      label: "audio output",
      deltaType: "response.output_audio_transcript.delta",
      doneType: "response.output_audio_transcript.done",
      doneField: { transcript: "hi there" },
    },
    {
      label: "text output",
      deltaType: "response.output_text.delta",
      doneType: "response.output_text.done",
      doneField: { text: "hi there" },
    },
  ])(
    "emits assistant transcripts from OpenAI Realtime $label events",
    async ({ deltaType, doneType, doneField }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
      );
      const onTranscript = vi.fn();
      const onTalkEvent = vi.fn();
      const transport = new WebRtcSdpRealtimeTalkTransport(
        {
          provider: "openai",
          transport: "webrtc",
          clientSecret: "client-secret-123",
        },
        {
          input: await prepareRealtimeTalkTestInput(),
          client: {} as never,
          sessionKey: "main",
          callbacks: { onTranscript, onTalkEvent },
        },
      );

      await transport.start();
      const peer = FakePeerConnection.instances[0];
      peer?.channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: deltaType, item_id: "response-1", delta: "hi" }),
        }),
      );
      peer?.channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: doneType, item_id: "response-1", ...doneField }),
        }),
      );

      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi",
        final: false,
      });
      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi there",
        final: true,
      });
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "output.text.delta",
        "output.text.done",
      ]);
      expect(onTalkEvent.mock.calls.map(([event]) => event.payload)).toEqual([
        { text: "hi" },
        { text: "hi there" },
      ]);
      transport.stop();
    },
  );

  it("aborts an in-flight OpenAI tool consult when the transport stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.abort") {
        expect(params).toEqual({ sessionKey: "main", runId: "run-1" });
        return { ok: true, aborted: true };
      }
      expect(method).toBe("talk.client.toolCall");
      expect(params.callId).toBe("call-1");
      expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
      return { runId: "run-1" };
    });
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {
          addEventListener: vi.fn(
            (listener: (event: { event: string; payload?: unknown }) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          ),
          request,
        } as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchConsultToolCall(peer);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
      sessionKey: "main",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });

    transport.stop();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "main", runId: "run-1" }),
    );
    expect(listeners.size).toBe(0);
  });

  it("sends spoken active-control acknowledgements through the OpenAI data channel", async () => {
    stubAnswerSdpFetch();
    const request = vi.fn(async (method: string) => {
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
    const { transport, peer } = await startActiveConsult(request);

    dispatchTranscription(peer, "status");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const sent = sentRealtimeEvents(peer);
    expectSpokenStatusMessage(sent, "OpenClaw is working in read (running).");
    expect(sent).toContainEqual({ type: "response.create" });
    transport.stop();
  });

  it("defers spoken active-control response creation until the active OpenAI response ends", async () => {
    stubAnswerSdpFetch();
    const request = vi.fn(async (method: string) => {
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
    const { transport, peer } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "status");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    let sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({ type: "response.cancel" });
    expectSpokenStatusMessage(sent, "OpenClaw is working in read (running).");
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(0);

    dispatchRealtimeEvent(peer, { type: "response.done", response: { status: "completed" } });

    sent = sentRealtimeEvents(peer);
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    transport.stop();
  });

  it("replaces stale OpenAI output with a spoken active-control steering acknowledgement", async () => {
    stubAnswerSdpFetch();
    const request = vi.fn(async (method: string) => {
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
    const { transport, peer } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "actually focus on WebUI");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({ type: "response.cancel" });
    expectSpokenStatusMessage(sent, "Got it. I steered the active run.");
    expect(sent.some((event) => event.type === "response.create")).toBe(false);
    transport.stop();
  });

  it("interrupts stale OpenAI output when active-control cancel is suppressed", async () => {
    stubAnswerSdpFetch();
    const request = vi.fn(async (method: string) => {
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
    const { transport, peer } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "cancel that");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({ type: "response.cancel" });
    expect(
      sent.some(
        (event) => event.type === "conversation.item.create" && event.item?.type === "message",
      ),
    ).toBe(false);
    transport.stop();
  });

  it("does not auto-control ambiguous multilingual speech during an active consult", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {
          addEventListener: vi.fn(() => () => undefined),
          request,
        } as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchConsultToolCall(peer);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "input-1",
          transcript: "¿cómo va esto?",
        }),
      }),
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(request).not.toHaveBeenCalledWith("talk.client.steer", expect.any(Object));
    transport.stop();
  });
});
