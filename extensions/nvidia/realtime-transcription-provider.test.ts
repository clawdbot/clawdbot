import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  clients: [] as Array<{
    server: string;
    call: EventEmitter & { writes: unknown[]; writableLength: number; end: () => void };
    metadata?: { get(key: string): unknown[] };
  }>,
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

vi.mock("@grpc/grpc-js", () => {
  class Metadata {
    private values = new Map<string, unknown[]>();
    set(key: string, value: unknown) {
      this.values.set(key, [value]);
    }
    get(key: string) {
      return this.values.get(key) ?? [];
    }
  }
  class Client {
    private entry: (typeof mocks.clients)[number];
    constructor(server: string) {
      const call = Object.assign(new EventEmitter(), {
        writes: [] as unknown[],
        writableLength: 0,
        end: vi.fn(),
        write(value: unknown) {
          this.writes.push(value);
          return true;
        },
      });
      this.entry = { server, call };
      mocks.clients.push(this.entry);
    }
    waitForReady(_deadline: number, callback: (error?: Error) => void) {
      callback();
    }
    makeBidiStreamRequest(
      _path: string,
      _serialize: unknown,
      _deserialize: unknown,
      metadata: { get(key: string): unknown[] },
    ) {
      this.entry.metadata = metadata;
      return this.entry.call;
    }
    close() {}
  }
  return { Client, Metadata, credentials: { createSsl: () => ({}) } };
});

import { buildNvidiaRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("NVIDIA realtime transcription provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clients.length = 0;
    mocks.catalog.mockResolvedValue({
      cloud: {
        transport: "grpc",
        server: "grpc.nvcf.nvidia.com:443",
        functionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        defaultLanguage: "en-US",
      },
    });
  });

  it("streams Talk relay mu-law audio through Nemotron ASR Streaming", async () => {
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
    const client = mocks.clients[0]!;
    expect(client.server).toBe("grpc.nvcf.nvidia.com:443");
    expect(client.metadata?.get("authorization")).toEqual(["Bearer nvapi-test"]);
    expect(client.metadata?.get("function-id")).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(client.call.writes[0]).toEqual({
      streamingConfig: {
        config: {
          encoding: 1,
          sampleRateHertz: 8000,
          languageCode: "en-US",
          maxAlternatives: 1,
          audioChannelCount: 1,
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
      },
    });

    session.sendAudio(Buffer.from([1, 2, 3]));
    expect(client.call.writes[1]).toEqual({ audioContent: expect.any(Buffer) });
    expect((client.call.writes[1] as { audioContent: Buffer }).audioContent).toHaveLength(6);
    client.call.emit("data", {
      results: [{ alternatives: [{ transcript: "hello" }], isFinal: false }],
    });
    client.call.emit("data", {
      results: [{ alternatives: [{ transcript: "hello NVIDIA" }], isFinal: true }],
    });
    expect(partials).toEqual(["hello"]);
    expect(transcripts).toEqual(["hello NVIDIA"]);
    expect(speechStarts).toHaveBeenCalledOnce();
    expect(session.isConnected()).toBe(true);
    session.close();
    expect(session.isConnected()).toBe(false);
  });

  it("uses the catalog language and does not send the public catalog model as a Riva model", async () => {
    mocks.catalog.mockResolvedValue({
      cloud: {
        transport: "grpc",
        server: "grpc.nvcf.nvidia.com:443",
        functionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        defaultLanguage: "en-GB",
      },
    });
    const provider = buildNvidiaRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "nvapi-test",
        model: "nvidia/nemotron-asr-streaming",
      },
    });

    await session.connect();

    expect(mocks.clients[0]?.call.writes[0]).toEqual({
      streamingConfig: {
        config: expect.objectContaining({ languageCode: "en-GB" }),
        interimResults: true,
      },
    });
    const request = mocks.clients[0]!.call.writes[0] as {
      streamingConfig: { config: object };
    };
    expect(request.streamingConfig.config).not.toHaveProperty("model");
    session.close();
  });

  it("does not send an ambient NVIDIA credential to a custom gRPC server", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "ambient-secret");
    const provider = buildNvidiaRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        server: "speech.example:443",
        functionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    await expect(session.connect()).rejects.toThrow("custom server requires an explicit apiKey");
  });
});
