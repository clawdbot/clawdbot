import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("Lazy capability metadata must not load the broad agent runtime");
});

const runtimeMocks = vi.hoisted(() => {
  const generateImage = vi.fn();
  const transcribeAudio = vi.fn();
  const generateVideo = vi.fn();
  const listVoices = vi.fn();
  const synthesize = vi.fn();
  const streamSynthesize = vi.fn();
  const synthesizeTelephony = vi.fn();
  const transcriptionConnect = vi.fn();
  const transcriptionSendAudio = vi.fn();
  const transcriptionClose = vi.fn();
  const transcriptionIsConnected = vi.fn();
  const createTranscriptionSession = vi.fn();
  const voiceConnect = vi.fn();
  const voiceSendAudio = vi.fn();
  const voiceSetMediaTimestamp = vi.fn();
  const voiceSendUserMessage = vi.fn();
  const voiceTriggerGreeting = vi.fn();
  const voiceHandleBargeIn = vi.fn();
  const voiceSubmitToolResult = vi.fn();
  const voiceAcknowledgeMark = vi.fn();
  const voiceClose = vi.fn();
  const voiceIsConnected = vi.fn();
  const createVoiceBridge = vi.fn();
  const buildImageProvider = vi.fn();
  const buildMediaProvider = vi.fn();
  const buildVideoProvider = vi.fn();
  const buildSpeechProvider = vi.fn();
  const buildTranscriptionProvider = vi.fn();
  const buildVoiceProvider = vi.fn();

  return {
    generateImage,
    transcribeAudio,
    generateVideo,
    listVoices,
    synthesize,
    streamSynthesize,
    synthesizeTelephony,
    transcriptionConnect,
    transcriptionSendAudio,
    transcriptionClose,
    transcriptionIsConnected,
    createTranscriptionSession,
    voiceConnect,
    voiceSendAudio,
    voiceSetMediaTimestamp,
    voiceSendUserMessage,
    voiceTriggerGreeting,
    voiceHandleBargeIn,
    voiceSubmitToolResult,
    voiceAcknowledgeMark,
    voiceClose,
    voiceIsConnected,
    createVoiceBridge,
    buildImageProvider,
    buildMediaProvider,
    buildVideoProvider,
    buildSpeechProvider,
    buildTranscriptionProvider,
    buildVoiceProvider,
  };
});

vi.mock("./image-generation-provider.js", () => ({
  buildXaiImageGenerationProvider: runtimeMocks.buildImageProvider,
}));
vi.mock("./stt.js", () => ({
  buildXaiMediaUnderstandingProvider: runtimeMocks.buildMediaProvider,
}));
vi.mock("./video-generation-provider.js", () => ({
  buildXaiVideoGenerationProvider: runtimeMocks.buildVideoProvider,
}));
vi.mock("./speech-provider.js", () => ({
  buildXaiSpeechProvider: runtimeMocks.buildSpeechProvider,
}));
vi.mock("./realtime-transcription-provider.js", () => ({
  buildXaiRealtimeTranscriptionProvider: runtimeMocks.buildTranscriptionProvider,
}));
vi.mock("./realtime-voice-provider.js", () => ({
  buildXaiRealtimeVoiceProvider: runtimeMocks.buildVoiceProvider,
}));

const lazyProvidersUrl = new URL("./lazy-capability-providers.ts", import.meta.url).href;
let lazyProviderCase = 0;

async function loadLazyProviders(): Promise<typeof import("./lazy-capability-providers.js")> {
  return await import(`${lazyProvidersUrl}?testCase=${lazyProviderCase}`);
}

function createVoiceRequest(
  overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
): RealtimeVoiceBridgeCreateRequest {
  return {
    providerConfig: {},
    onAudio() {},
    onClearAudio() {},
    onError() {},
    ...overrides,
  };
}

beforeEach(() => {
  // Refresh provider caches without reloading unchanged SDK dependencies.
  lazyProviderCase += 1;
  for (const value of Object.values(runtimeMocks)) {
    value.mockReset();
  }

  runtimeMocks.generateImage.mockResolvedValue({ images: [] });
  runtimeMocks.transcribeAudio.mockResolvedValue({ text: "transcript" });
  runtimeMocks.generateVideo.mockResolvedValue({ videos: [] });
  runtimeMocks.listVoices.mockResolvedValue([]);
  runtimeMocks.synthesize.mockResolvedValue({ audioBuffer: Buffer.alloc(0) });
  runtimeMocks.streamSynthesize.mockResolvedValue({ audioStream: {} });
  runtimeMocks.synthesizeTelephony.mockResolvedValue({ audioBuffer: Buffer.alloc(0) });
  runtimeMocks.transcriptionConnect.mockResolvedValue(undefined);
  runtimeMocks.transcriptionIsConnected.mockReturnValue(false);
  runtimeMocks.voiceConnect.mockResolvedValue(undefined);
  runtimeMocks.voiceIsConnected.mockReturnValue(false);

  runtimeMocks.createTranscriptionSession.mockReturnValue({
    connect: runtimeMocks.transcriptionConnect,
    sendAudio: runtimeMocks.transcriptionSendAudio,
    close: runtimeMocks.transcriptionClose,
    isConnected: runtimeMocks.transcriptionIsConnected,
  });
  runtimeMocks.createVoiceBridge.mockImplementation(
    () =>
      ({
        supportsToolResultContinuation: false,
        connect: runtimeMocks.voiceConnect,
        sendAudio: runtimeMocks.voiceSendAudio,
        setMediaTimestamp: runtimeMocks.voiceSetMediaTimestamp,
        sendUserMessage: runtimeMocks.voiceSendUserMessage,
        triggerGreeting: runtimeMocks.voiceTriggerGreeting,
        handleBargeIn: runtimeMocks.voiceHandleBargeIn,
        submitToolResult: runtimeMocks.voiceSubmitToolResult,
        acknowledgeMark: runtimeMocks.voiceAcknowledgeMark,
        close: runtimeMocks.voiceClose,
        isConnected: runtimeMocks.voiceIsConnected,
      }) satisfies RealtimeVoiceBridge,
  );

  runtimeMocks.buildImageProvider.mockReturnValue({
    generateImage: runtimeMocks.generateImage,
  });
  runtimeMocks.buildMediaProvider.mockReturnValue({
    transcribeAudio: runtimeMocks.transcribeAudio,
  });
  runtimeMocks.buildVideoProvider.mockReturnValue({
    generateVideo: runtimeMocks.generateVideo,
  });
  runtimeMocks.buildSpeechProvider.mockReturnValue({
    listVoices: runtimeMocks.listVoices,
    synthesize: runtimeMocks.synthesize,
    streamSynthesize: runtimeMocks.streamSynthesize,
    synthesizeTelephony: runtimeMocks.synthesizeTelephony,
  });
  runtimeMocks.buildTranscriptionProvider.mockReturnValue({
    createSession: runtimeMocks.createTranscriptionSession,
  });
  runtimeMocks.buildVoiceProvider.mockReturnValue({
    createBridge: runtimeMocks.createVoiceBridge,
  });
});

describe("xAI lazy capability providers", () => {
  it("keeps heavy builders unloaded until their capability methods run", async () => {
    const lazy = await loadLazyProviders();
    const image = lazy.createLazyXaiImageGenerationProvider();
    const media = lazy.createLazyXaiMediaUnderstandingProvider();
    const video = lazy.createLazyXaiVideoGenerationProvider();
    const speech = lazy.createLazyXaiSpeechProvider();
    const transcription = lazy.createLazyXaiRealtimeTranscriptionProvider();
    const voice = lazy.createLazyXaiRealtimeVoiceProvider();
    await vi.dynamicImportSettled();

    expect(
      [
        runtimeMocks.buildImageProvider,
        runtimeMocks.buildMediaProvider,
        runtimeMocks.buildVideoProvider,
        runtimeMocks.buildSpeechProvider,
        runtimeMocks.buildTranscriptionProvider,
        runtimeMocks.buildVoiceProvider,
      ].map((mock) => mock.mock.calls.length),
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(transcription.label).toBe("xAI Realtime Transcription");
    expect(voice.label).toBe("xAI Grok Voice");

    await image.generateImage({} as never);
    await media.transcribeAudio?.({} as never);
    await video.generateVideo({} as never);
    await speech.synthesize({} as never);
    await speech.listVoices?.({} as never);

    expect(runtimeMocks.buildImageProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildMediaProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildVideoProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.buildSpeechProvider).toHaveBeenCalledOnce();
    expect(runtimeMocks.generateImage).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(runtimeMocks.generateVideo).toHaveBeenCalledOnce();
    expect(runtimeMocks.synthesize).toHaveBeenCalledOnce();
    expect(runtimeMocks.listVoices).toHaveBeenCalledOnce();
  });

  it("keeps the newest transcription audio ordered while the runtime loads", async () => {
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider().createSession({
      providerConfig: {},
    });
    const first = Buffer.alloc(1024 * 1024, 0x01);
    const second = Buffer.alloc(1024 * 1024, 0x02);
    const third = Buffer.alloc(1024 * 1024, 0x03);

    session.sendAudio(first);
    session.sendAudio(second);
    session.sendAudio(third);
    await session.connect();

    expect(runtimeMocks.buildTranscriptionProvider).toHaveBeenCalledOnce();
    const forwardedAudio = runtimeMocks.transcriptionSendAudio.mock.calls.map(([audio]) => audio);
    expect(forwardedAudio).toHaveLength(2);
    for (const [index, expected] of [second, third].entries()) {
      const audio = forwardedAudio[index];
      expect(Buffer.isBuffer(audio) && audio.equals(expected)).toBe(true);
    }
    expect(runtimeMocks.transcriptionConnect).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcriptionConnect.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMocks.transcriptionSendAudio.mock.invocationCallOrder[0]!,
    );
  });

  it("closes a transcription session that finishes loading after the wrapper closes", async () => {
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider().createSession({
      providerConfig: {},
    });

    const connectPromise = session.connect();
    session.close();
    session.close();
    await connectPromise;

    expect(runtimeMocks.createTranscriptionSession).toHaveBeenCalledOnce();
    expect(runtimeMocks.transcriptionConnect).not.toHaveBeenCalled();
    expect(runtimeMocks.transcriptionClose).toHaveBeenCalledOnce();
  });

  it("reopens transcription after close without replaying discarded audio", async () => {
    const reconnecting = createDeferred<void>();
    const forwarded: Buffer[] = [];
    const events: string[] = [];
    let connectCount = 0;
    let providerClosed = false;
    runtimeMocks.transcriptionConnect.mockImplementation(() => {
      providerClosed = false;
      connectCount += 1;
      if (connectCount === 1) {
        return Promise.resolve();
      }
      events.push("connect-start");
      return reconnecting.promise.then(() => {
        events.push("connect-settle");
      });
    });
    runtimeMocks.transcriptionClose.mockImplementation(() => {
      providerClosed = true;
    });
    runtimeMocks.transcriptionSendAudio.mockImplementation((audio: Buffer) => {
      events.push(`${providerClosed ? "drop" : "audio"}:${audio[0]}`);
      if (!providerClosed) {
        forwarded.push(audio);
      }
    });
    const lazy = await loadLazyProviders();
    const session = lazy.createLazyXaiRealtimeTranscriptionProvider().createSession({
      providerConfig: {},
    });
    const first = Buffer.from([0x01]);
    const discarded = Buffer.from([0x02]);
    const droppedByLimit = Buffer.alloc(1024 * 1024, 0x03);
    const retainedFirst = Buffer.alloc(1024 * 1024, 0x04);
    const retainedSecond = Buffer.alloc(1024 * 1024, 0x05);
    const live = Buffer.from([0x06]);

    session.sendAudio(first);
    await session.connect();
    session.close();
    session.close();
    session.sendAudio(discarded);
    events.length = 0;

    const reconnectPromise = session.connect();
    session.sendAudio(droppedByLimit);
    session.sendAudio(retainedFirst);
    session.sendAudio(retainedSecond);
    await vi.waitFor(() => expect(runtimeMocks.transcriptionConnect).toHaveBeenCalledTimes(2));
    session.sendAudio(live);

    expect(runtimeMocks.transcriptionClose).toHaveBeenCalledOnce();
    expect(forwarded.map((audio) => [audio[0], audio.byteLength])).toEqual([
      [1, 1],
      [4, 1024 * 1024],
      [5, 1024 * 1024],
      [6, 1],
    ]);
    expect(events).toEqual(["connect-start", "audio:4", "audio:5", "audio:6"]);

    reconnecting.resolve();
    await reconnectPromise;
    expect(events.at(-1)).toBe("connect-settle");
  });

  it("preserves voice startup ordering and waits to trigger the greeting", async () => {
    const connecting = createDeferred<void>();
    const forwarded: string[] = [];
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    runtimeMocks.voiceSendAudio.mockImplementation((audio: Buffer) => {
      forwarded.push(`audio:${audio[0]}`);
    });
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSubmitToolResult.mockImplementation((callId: string) => {
      forwarded.push(`tool:${callId}`);
    });
    runtimeMocks.voiceTriggerGreeting.mockImplementation((instructions?: string) => {
      forwarded.push(`greeting:${instructions ?? ""}`);
    });
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(createVoiceRequest());
    const first = Buffer.from([0x01]);
    const second = Buffer.from([0x02]);

    bridge.sendAudio(first);
    bridge.setMediaTimestamp(42);
    bridge.sendUserMessage?.("hello");
    await bridge.submitToolResult("call-1", { ok: true });
    bridge.triggerGreeting?.("welcome");
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    bridge.sendAudio(second);

    expect(runtimeMocks.voiceSetMediaTimestamp).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSendUserMessage).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceTriggerGreeting).not.toHaveBeenCalled();

    connecting.resolve();
    await connectPromise;
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenCalledWith(42);
    expect(runtimeMocks.voiceSendAudio.mock.calls.map(([audio]) => audio)).toEqual([first, second]);
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("hello");
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      undefined,
    );
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledWith("welcome");
    expect(forwarded).toEqual([
      "audio:1",
      "timestamp:42",
      "user:hello",
      "tool:call-1",
      "greeting:welcome",
      "audio:2",
    ]);
  });

  it("moves the latest pending timestamp and greeting to the operation tail", async () => {
    const forwarded: string[] = [];
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSendAudio.mockImplementation((audio: Buffer) => {
      forwarded.push(`audio:${audio[0]}`);
    });
    runtimeMocks.voiceTriggerGreeting.mockImplementation((instructions?: string) => {
      forwarded.push(`greeting:${String(instructions)}`);
    });
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(createVoiceRequest());

    bridge.setMediaTimestamp(1);
    bridge.sendUserMessage?.("middle");
    bridge.setMediaTimestamp(2);
    bridge.triggerGreeting?.("superseded");
    bridge.sendAudio(Buffer.from([0x03]));
    bridge.triggerGreeting?.();
    await bridge.connect();

    expect(forwarded).toEqual(["user:middle", "timestamp:2", "audio:3", "greeting:undefined"]);

    runtimeMocks.voiceTriggerGreeting.mockClear();
    runtimeMocks.voiceIsConnected.mockReturnValue(false);
    bridge.triggerGreeting?.("provider-owned-reconnect");
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledWith("provider-owned-reconnect");
  });

  it("bounds pending voice user messages by aggregate bytes", async () => {
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));
    const accepted = "a".repeat(200 * 1024);

    bridge.sendUserMessage?.(accepted);
    bridge.sendUserMessage?.("b".repeat(64 * 1024));
    await bridge.connect();

    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith(accepted);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("xAI realtime voice pending user message overflow during lazy startup"),
    );
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["function", () => () => undefined],
    ["symbol", () => Symbol("invalid-tool-result")],
    ["bigint", () => ({ value: 1n })],
    [
      "circular",
      () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    ],
    ["omitted custom serialization", () => ({ toJSON: () => undefined })],
  ] as const)(
    "rejects %s voice tool results before lazy queue admission",
    async (_label, create) => {
      const lazy = await loadLazyProviders();
      const onError = vi.fn();
      const bridge = lazy
        .createLazyXaiRealtimeVoiceProvider()
        .createBridge(createVoiceRequest({ onError }));

      expect(() => bridge.submitToolResult("call-1", create())).toThrow(/serializ/i);
      expect(onError).toHaveBeenCalledOnce();

      await bridge.submitToolResult("call-1", { recovered: true });
      await bridge.connect();

      expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
        "call-1",
        { recovered: true },
        undefined,
      );
    },
  );

  it("snapshots lazy voice tool results with one canonical serialization", async () => {
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(createVoiceRequest());
    const toJSON = vi.fn((key: string) => ({ key, ok: true }));

    await bridge.submitToolResult("call-1", { toJSON });
    await bridge.connect();

    expect(toJSON).toHaveBeenCalledExactlyOnceWith("");
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledExactlyOnceWith(
      "call-1",
      { key: "", ok: true },
      undefined,
    );
  });

  it("ignores unsupported interim voice results before lazy queue admission", async () => {
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));

    expect(() =>
      bridge.submitToolResult("call-1", undefined, { willContinue: true }),
    ).not.toThrow();
    await bridge.connect();

    expect(onError).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
  });

  it("bounds pending voice tool results by aggregate serialized bytes", async () => {
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));
    const accepted = { text: "a".repeat(200 * 1024) };

    await bridge.submitToolResult("call-1", accepted);
    expect(() => bridge.submitToolResult("call-2", { text: "b".repeat(64 * 1024) })).toThrow(
      "xAI realtime voice pending tool result overflow during lazy startup",
    );
    await bridge.connect();

    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith("call-1", accepted, undefined);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("xAI realtime voice pending tool result overflow during lazy startup"),
    );
  });

  it("keeps voice payloads byte-bounded until the underlying connect resolves", async () => {
    const connecting = createDeferred<void>();
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));
    const acceptedMessage = "a".repeat(200 * 1024);
    const acceptedResult = { text: "b".repeat(200 * 1024) };

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.(acceptedMessage);
    bridge.sendUserMessage?.("c".repeat(64 * 1024));
    await bridge.submitToolResult("call-1", acceptedResult);
    expect(() => bridge.submitToolResult("call-2", { text: "d".repeat(64 * 1024) })).toThrow(
      "xAI realtime voice pending tool result overflow during lazy startup",
    );

    expect(runtimeMocks.voiceSendUserMessage).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSubmitToolResult).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      "xAI realtime voice pending user message overflow during lazy startup",
      "xAI realtime voice pending tool result overflow during lazy startup",
    ]);

    connecting.resolve();
    await connectPromise;

    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith(acceptedMessage);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith(
      "call-1",
      acceptedResult,
      undefined,
    );
  });

  it("drains voice input queued while an earlier tool result is submitting", async () => {
    const submitting = createDeferred<void>();
    const forwarded: string[] = [];
    runtimeMocks.voiceSubmitToolResult
      .mockImplementationOnce((callId: string) => {
        forwarded.push(`tool:${callId}`);
        return submitting.promise;
      })
      .mockImplementation((callId: string) => {
        forwarded.push(`tool:${callId}`);
      });
    runtimeMocks.voiceSendUserMessage.mockImplementation((text: string) => {
      forwarded.push(`user:${text}`);
    });
    runtimeMocks.voiceSetMediaTimestamp.mockImplementation((timestamp: number) => {
      forwarded.push(`timestamp:${timestamp}`);
    });
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(createVoiceRequest());

    await bridge.submitToolResult("call-1", { text: "first" });
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce());
    bridge.sendUserMessage?.("arrived-during-flush");
    bridge.setMediaTimestamp(84);
    await bridge.submitToolResult("call-2", { text: "second" });
    submitting.resolve();
    await connectPromise;

    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("arrived-during-flush");
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenLastCalledWith(84);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenLastCalledWith(
      "call-2",
      { text: "second" },
      undefined,
    );
    expect(forwarded).toEqual([
      "tool:call-1",
      "user:arrived-during-flush",
      "timestamp:84",
      "tool:call-2",
    ]);
  });

  it("keeps an in-flight voice tool result charged against the startup byte cap", async () => {
    const submitting = createDeferred<void>();
    runtimeMocks.voiceSubmitToolResult.mockReturnValueOnce(submitting.promise);
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));

    await bridge.submitToolResult("call-1", { text: "a".repeat(200 * 1024) });
    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce());
    expect(() => bridge.submitToolResult("call-2", { text: "b".repeat(64 * 1024) })).toThrow(
      "xAI realtime voice pending tool result overflow during lazy startup",
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("xAI realtime voice pending tool result overflow during lazy startup"),
    );
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();

    submitting.resolve();
    await connectPromise;
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
  });

  it("forwards all voice input admitted during the final connect handoff exactly once", async () => {
    const connecting = createDeferred<void>();
    runtimeMocks.voiceConnect.mockReturnValue(connecting.promise);
    runtimeMocks.voiceIsConnected.mockReturnValue(true);
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(createVoiceRequest());
    const audio = Buffer.from([0x01]);

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    connecting.resolve();
    queueMicrotask(() => {
      bridge.sendAudio(audio);
      bridge.setMediaTimestamp(84);
      bridge.sendUserMessage?.("arrived-during-handoff");
      void bridge.submitToolResult("call-1", { text: "tool-result" });
      bridge.triggerGreeting?.("welcome");
    });
    await Promise.all([firstConnect, secondConnect]);

    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledWith(audio);
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSetMediaTimestamp).toHaveBeenCalledWith(84);
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("arrived-during-handoff");
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith(
      "call-1",
      { text: "tool-result" },
      undefined,
    );
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceTriggerGreeting).toHaveBeenCalledWith("welcome");
  });

  it("clears pending voice byte budgets when closed before connect", async () => {
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError }));

    bridge.sendUserMessage?.("stale".repeat(40 * 1024));
    bridge.setMediaTimestamp(42);
    await bridge.submitToolResult("stale-call", { text: "x".repeat(200 * 1024) });
    bridge.close();

    const connectPromise = bridge.connect();
    bridge.sendUserMessage?.("fresh".repeat(40 * 1024));
    await bridge.submitToolResult("fresh-call", { text: "y".repeat(200 * 1024) });
    await connectPromise;

    expect(onError).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSetMediaTimestamp).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("fresh".repeat(40 * 1024));
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSubmitToolResult).toHaveBeenCalledWith(
      "fresh-call",
      { text: "y".repeat(200 * 1024) },
      undefined,
    );
  });

  it("closes a voice bridge that finishes loading after the wrapper closes", async () => {
    const lazy = await loadLazyProviders();
    const onClose = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onClose }));

    const connectPromise = bridge.connect();
    bridge.close();
    bridge.close();
    await connectPromise;

    expect(runtimeMocks.createVoiceBridge).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceConnect).not.toHaveBeenCalled();
    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("reopens voice after close without replaying discarded input", async () => {
    const lazy = await loadLazyProviders();
    const onClose = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onClose }));
    const first = Buffer.from([0x01]);
    const discarded = Buffer.from([0x02]);
    const second = Buffer.from([0x03]);

    bridge.sendAudio(first);
    await bridge.connect();
    bridge.close();
    bridge.close();
    bridge.sendAudio(discarded);

    const reconnectPromise = bridge.connect();
    bridge.sendAudio(second);
    await reconnectPromise;

    expect(runtimeMocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendAudio.mock.calls.map(([audio]) => audio)).toEqual([first, second]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("keeps a replacement voice generation open when a superseded connect rejects", async () => {
    const failure = new Error("superseded voice connect rejected");
    const firstConnect = createDeferred<void>();
    runtimeMocks.voiceConnect
      .mockReturnValueOnce(firstConnect.promise)
      .mockResolvedValueOnce(undefined);
    const lazy = await loadLazyProviders();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError, onClose }));

    const staleConnect = bridge.connect();
    const staleConnectResult = expect(staleConnect).rejects.toBe(failure);
    await vi.waitFor(() => expect(runtimeMocks.voiceConnect).toHaveBeenCalledOnce());
    const staleRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    bridge.close();
    const replacementConnect = bridge.connect();
    await replacementConnect;
    staleRequest?.onClose?.("error");
    bridge.sendUserMessage?.("replacement-still-open");
    firstConnect.reject(failure);
    await staleConnectResult;

    expect(runtimeMocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createVoiceBridge).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendUserMessage).toHaveBeenCalledWith("replacement-still-open");
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("ignores nonterminal callbacks from a superseded voice generation", async () => {
    const onAudio = vi.fn();
    const playback = [{ itemId: "current-item", audioEndMs: 320 }];
    const getPlaybackState = vi.fn(() => playback);
    const onClearAudio = vi.fn();
    const onMark = vi.fn();
    const onTranscript = vi.fn();
    const onEvent = vi.fn();
    const onToolCall = vi.fn();
    const onReady = vi.fn();
    const onError = vi.fn();
    const lazy = await loadLazyProviders();
    const bridge = lazy.createLazyXaiRealtimeVoiceProvider().createBridge(
      createVoiceRequest({
        onAudio,
        getPlaybackState,
        onClearAudio,
        onMark,
        onTranscript,
        onEvent,
        onToolCall,
        onReady,
        onError,
      }),
    );

    await bridge.connect();
    const staleRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    bridge.close();
    await bridge.connect();
    const currentRequest = runtimeMocks.createVoiceBridge.mock.calls[1]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    const staleAudio = Buffer.from([0x01]);
    const staleError = new Error("stale");
    const staleEvent = { direction: "server" as const, type: "stale" };
    const staleToolCall = {
      itemId: "stale-item",
      callId: "stale-call",
      name: "stale-tool",
      args: {},
    };

    staleRequest?.onAudio(staleAudio);
    expect(staleRequest?.getPlaybackState?.()).toEqual([]);
    expect(getPlaybackState).not.toHaveBeenCalled();
    staleRequest?.onClearAudio("barge-in");
    staleRequest?.onMark?.("stale-mark");
    staleRequest?.onTranscript?.("assistant", "stale", true);
    staleRequest?.onEvent?.(staleEvent);
    staleRequest?.onToolCall?.(staleToolCall);
    staleRequest?.onReady?.();
    staleRequest?.onError?.(staleError);

    expect(onAudio).not.toHaveBeenCalled();
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(onMark).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    const currentAudio = Buffer.from([0x02]);
    const currentError = new Error("current");
    const currentEvent = { direction: "server" as const, type: "current" };
    const currentToolCall = {
      itemId: "current-item",
      callId: "current-call",
      name: "current-tool",
      args: {},
    };
    currentRequest?.onAudio(currentAudio, { itemId: "current-item" });
    expect(currentRequest?.getPlaybackState?.()).toEqual(playback);
    currentRequest?.onClearAudio("barge-in");
    currentRequest?.onMark?.("current-mark");
    currentRequest?.onTranscript?.("assistant", "current", true);
    currentRequest?.onEvent?.(currentEvent);
    currentRequest?.onToolCall?.(currentToolCall);
    currentRequest?.onReady?.();
    currentRequest?.onError?.(currentError);

    expect(onAudio).toHaveBeenCalledWith(currentAudio, { itemId: "current-item" });
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(onMark).toHaveBeenCalledWith("current-mark");
    expect(onTranscript).toHaveBeenCalledWith("assistant", "current", true);
    expect(onEvent).toHaveBeenCalledWith(currentEvent);
    expect(onToolCall).toHaveBeenCalledWith(currentToolCall);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(currentError);
  });

  it("reports queued voice flush failure as a terminal error", async () => {
    const failure = new Error("tool result rejected");
    const callbackFailure = new Error("voice close callback rejected");
    runtimeMocks.voiceSubmitToolResult.mockRejectedValueOnce(failure);
    const lazy = await loadLazyProviders();
    const onClose = vi.fn(() => {
      throw callbackFailure;
    });
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onClose }));

    await bridge.submitToolResult("call-1", { text: "queued" });
    await expect(bridge.connect()).rejects.toBe(failure);
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    loadedRequest?.onClose?.("completed");
    bridge.sendAudio(Buffer.from([0x01]));

    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("reports voice connect failure as a terminal error", async () => {
    const failure = new Error("voice connect rejected");
    const errorCallbackFailure = new Error("voice error callback rejected");
    const closeCallbackFailure = new Error("voice close callback rejected");
    const cleanupFailure = new Error("voice cleanup rejected");
    const callbackOrder: string[] = [];
    runtimeMocks.voiceConnect.mockRejectedValueOnce(failure);
    runtimeMocks.voiceClose.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    const lazy = await loadLazyProviders();
    const onError = vi.fn((error: Error) => {
      callbackOrder.push(`error:${error.message}`);
      throw errorCallbackFailure;
    });
    const onClose = vi.fn(() => {
      callbackOrder.push("close:error");
      throw closeCallbackFailure;
    });
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onError, onClose }));

    await expect(bridge.connect()).rejects.toBe(failure);
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    loadedRequest?.onClose?.("completed");
    bridge.sendAudio(Buffer.from([0x01]));

    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(callbackOrder).toEqual(["error:voice connect rejected", "close:error"]);
  });

  it("reopens voice only after an explicit connect following provider termination", async () => {
    const lazy = await loadLazyProviders();
    const onClose = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onClose }));
    const discarded = Buffer.from([0x01]);
    const accepted = Buffer.from([0x02]);

    await bridge.connect();
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    loadedRequest?.onClose?.("error");
    bridge.sendAudio(discarded);

    const reconnectPromise = bridge.connect();
    bridge.sendAudio(accepted);
    await reconnectPromise;

    expect(runtimeMocks.voiceConnect).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledOnce();
    expect(runtimeMocks.voiceSendAudio).toHaveBeenCalledWith(accepted);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("reports explicit voice close once when the provider also reports completion", async () => {
    const lazy = await loadLazyProviders();
    const onClose = vi.fn();
    const bridge = lazy
      .createLazyXaiRealtimeVoiceProvider()
      .createBridge(createVoiceRequest({ onClose }));

    await bridge.connect();
    const loadedRequest = runtimeMocks.createVoiceBridge.mock.calls[0]?.[0] as
      | RealtimeVoiceBridgeCreateRequest
      | undefined;
    runtimeMocks.voiceClose.mockImplementation(() => loadedRequest?.onClose?.("completed"));
    bridge.close();
    bridge.close();

    expect(runtimeMocks.voiceClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("keeps realtime voice request validation synchronous", async () => {
    const lazy = await loadLazyProviders();
    const provider = lazy.createLazyXaiRealtimeVoiceProvider();

    expect(() => provider.createBridge(createVoiceRequest({ autoRespondToAudio: false }))).toThrow(
      "xAI realtime voice requires automatic server-VAD responses",
    );
    expect(runtimeMocks.buildVoiceProvider).not.toHaveBeenCalled();
  });
});
