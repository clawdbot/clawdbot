import { beforeEach, describe, expect, it, vi } from "vitest";

type Transport = {
  callbacks: {
    onPartial?: (text: string) => void;
    onTranscript?: (text: string) => void;
    onSpeechStart?: () => void;
    onError?: (error: Error) => void;
  };
  failConnect: (error: Error) => void;
  isReady: () => boolean;
  markReady: () => void;
  sendJson: (value: unknown) => boolean;
};
type SessionOptions = {
  callbacks: Transport["callbacks"];
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  protocols: () => string[] | Promise<string[]>;
  url: () => string | Promise<string>;
  onOpen: (transport: Transport) => void;
  onMessage: (event: Record<string, unknown>, transport: Transport) => void;
  sendAudio: (audio: Buffer, transport: Transport) => void;
  onClose: (transport: Transport) => void;
};

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  options: undefined as SessionOptions | undefined,
  sent: [] as unknown[],
  ready: false,
}));

vi.mock("./nvidia-speech-catalog.js", () => ({
  NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID: "nvidia/nemotron-asr-streaming",
  resolveNvidiaSpeechCatalogModel: mocks.catalog,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: vi.fn(() => false),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/realtime-transcription", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRealtimeTranscriptionWebSocketSession: vi.fn((options: SessionOptions) => {
      mocks.options = options;
      const transport: Transport = {
        callbacks: options.callbacks,
        failConnect: (error) => {
          throw error;
        },
        isReady: () => mocks.ready,
        markReady: () => {
          mocks.ready = true;
        },
        sendJson: (value) => {
          mocks.sent.push(value);
          return true;
        },
      };
      return {
        connect: async () => {
          await options.url();
          await options.headers();
          await options.protocols();
          options.onOpen(transport);
        },
        sendAudio: (audio: Buffer) => options.sendAudio(audio, transport),
        close: () => options.onClose(transport),
        isConnected: () => mocks.ready,
      };
    }),
  };
});

import { buildNvidiaRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("NVIDIA realtime transcription provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.options = undefined;
    mocks.sent.length = 0;
    mocks.ready = false;
    mocks.catalog.mockResolvedValue({
      cloud: {
        transport: "grpc",
        functionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        defaultLanguage: "en-GB",
        realtime: {
          transport: "websocket",
          sessionUrl:
            "https://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.invocation.api.nvcf.nvidia.com/v1/realtime/transcription_sessions",
          websocketUrl: "wss://grpc.nvcf.nvidia.com:443/v1/realtime?intent=transcription",
          requestStyle: "nvcf-realtime-transcription",
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              client_secret: { value: "ephemeral-test-token" },
              input_audio_transcription: { model: "served-model-name" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
  });

  it("mints a hosted session and opens the NVIDIA realtime WebSocket", async () => {
    const provider = buildNvidiaRealtimeTranscriptionProvider();
    const session = provider.createSession({ providerConfig: { apiKey: "nvapi-test" } });

    await session.connect();

    expect(fetch).toHaveBeenCalledWith(
      "https://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.invocation.api.nvcf.nvidia.com/v1/realtime/transcription_sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer nvapi-test" }),
      }),
    );
    await expect(mocks.options?.url()).resolves.toBe(
      "wss://grpc.nvcf.nvidia.com:443/v1/realtime?intent=transcription",
    );
    await expect(Promise.resolve(mocks.options?.headers())).resolves.toEqual({
      Authorization: "Bearer nvapi-test",
      "function-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(Promise.resolve(mocks.options?.protocols())).resolves.toEqual([
      "realtime",
      "realtime-token.ephemeral-test-token",
    ]);
    expect(mocks.sent[0]).toEqual({
      type: "transcription_session.update",
      session: expect.objectContaining({
        input_audio_format: "pcm16",
        input_audio_params: { sample_rate_hz: 8000, num_channels: 1 },
        input_audio_transcription: { model: "served-model-name", language: "en-GB" },
      }),
    });
  });

  it("streams Talk relay mu-law audio and emits partial and final transcripts", async () => {
    const partials: string[] = [];
    const transcripts: string[] = [];
    const speechStarts = vi.fn();
    const provider = buildNvidiaRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "nvapi-test" },
      onPartial: (text) => partials.push(text),
      onTranscript: (text) => transcripts.push(text),
      onSpeechStart: speechStarts,
    });
    await session.connect();
    mocks.options?.onMessage(
      { type: "transcription_session.updated" },
      {
        callbacks: mocks.options.callbacks,
        failConnect: vi.fn(),
        isReady: () => mocks.ready,
        markReady: () => {
          mocks.ready = true;
        },
        sendJson: vi.fn(() => true),
      },
    );
    session.sendAudio(Buffer.from([1, 2, 3]));
    const append = mocks.sent[1] as { audio: string; type: string };
    expect(append.type).toBe("input_audio_buffer.append");
    expect(Buffer.from(append.audio, "base64")).toHaveLength(6);
    expect(mocks.sent[2]).toEqual({ type: "input_audio_buffer.commit" });

    const transport = {
      callbacks: mocks.options!.callbacks,
      failConnect: vi.fn(),
      isReady: () => true,
      markReady: vi.fn(),
      sendJson: vi.fn(() => true),
    };
    mocks.options?.onMessage(
      { type: "conversation.item.input_audio_transcription.delta", delta: "hello" },
      transport,
    );
    mocks.options?.onMessage(
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello NVIDIA",
      },
      transport,
    );
    expect(partials).toEqual(["hello"]);
    expect(transcripts).toEqual(["hello NVIDIA"]);
    expect(speechStarts).toHaveBeenCalledOnce();
  });

  it("does not replace the hosted model name with the public catalog id", async () => {
    const provider = buildNvidiaRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: { apiKey: "nvapi-test", model: "nvidia/nemotron-asr-streaming" },
    });
    await session.connect();
    expect(mocks.sent[0]).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          input_audio_transcription: {
            model: "served-model-name",
            language: "en-GB",
          },
        }),
      }),
    );
  });
});
