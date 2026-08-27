import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard };
});

const NVIDIA_CATALOG_ASR_MODEL_ID = "nvidia/parakeet-ctc-1.1b-asr";
const NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID = "nvidia/nemotron-asr-streaming";
const NVIDIA_CATALOG_TTS_MODEL_ID = "nvidia/magpie-tts-multilingual";
const NVIDIA_SPEECH_CATALOG_URL =
  "https://raw.githubusercontent.com/nvidia-riva/Nemotron-speech-skills/main/skills/nemotron-speech/references/speech-models.v1.json";
const ASR_FUNCTION_ID = "1598d209-5e27-4d3c-8079-4751568b1081";
const TTS_FUNCTION_ID = "877104f7-e885-42b9-8de8-f6e4c6303969";
const REALTIME_FUNCTION_ID = "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa";

function catalogPayload() {
  return {
    schemaVersion: 1,
    catalogId: "nvidia-nemotron-speech-cloud-models",
    updatedAt: "2026-08-13T00:00:00Z",
    defaults: {
      asr: { english: NVIDIA_CATALOG_ASR_MODEL_ID },
      tts: { multilingual: NVIDIA_CATALOG_TTS_MODEL_ID },
      nmt: { multilingual: "nvidia/riva-translate-1.6b" },
    },
    models: [
      {
        id: NVIDIA_CATALOG_ASR_MODEL_ID,
        displayName: "Parakeet CTC",
        modality: "asr",
        status: "active",
        capabilities: { languages: ["en-US"] },
        selection: { recommendedFor: ["English transcription"] },
        cloud: {
          functionName: "ai-parakeet-ctc-1_1b-asr",
          functionId: ASR_FUNCTION_ID,
          transport: "http",
          baseUrl: `https://${ASR_FUNCTION_ID}.invocation.api.nvcf.nvidia.com`,
          requestStyle: "openai-audio",
          defaultLanguage: "en-US",
        },
      },
      {
        id: NVIDIA_CATALOG_TTS_MODEL_ID,
        displayName: "Magpie TTS",
        modality: "tts",
        status: "active",
        capabilities: { languages: ["multi"] },
        selection: { recommendedFor: ["multilingual synthesis"] },
        cloud: {
          functionName: "ai-magpie-tts-multilingual",
          functionId: TTS_FUNCTION_ID,
          transport: "http",
          baseUrl: `https://${TTS_FUNCTION_ID}.invocation.api.nvcf.nvidia.com`,
          requestStyle: "riva-tts-http",
          defaultLanguage: "en-US",
        },
      },
      {
        id: NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
        displayName: "Nemotron ASR Streaming",
        modality: "asr",
        status: "active",
        capabilities: { languages: ["en-US"], modes: ["streaming"] },
        selection: { recommendedFor: ["realtime transcription"] },
        cloud: {
          functionName: "ai-nemotron-asr-streaming",
          functionId: REALTIME_FUNCTION_ID,
          transport: "grpc",
          server: "grpc.nvcf.nvidia.com:443",
          rpcMode: "streaming",
          defaultLanguage: "en-US",
          realtime: {
            transport: "websocket",
            sessionUrl: `https://${REALTIME_FUNCTION_ID}.invocation.api.nvcf.nvidia.com/v1/realtime/transcription_sessions`,
            websocketUrl: "wss://grpc.nvcf.nvidia.com:443/v1/realtime?intent=transcription",
            requestStyle: "nvcf-realtime-transcription",
          },
        },
      },
      {
        id: "nvidia/riva-translate-1.6b",
        displayName: "Riva Translate",
        modality: "nmt",
        status: "active",
        capabilities: { languages: ["multi"] },
        selection: { recommendedFor: ["translation"] },
        cloud: {
          functionName: "ai-riva-translate-1_6b",
          functionId: "0778f2eb-b64d-45e7-acae-7dd9b9b35b4d",
          transport: "grpc",
          server: "grpc.nvcf.nvidia.com:443",
          rpcMode: "online",
        },
      },
    ],
  };
}

function catalogResponse(payload: unknown) {
  return {
    response: new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(),
  };
}

describe("NVIDIA speech catalog", () => {
  beforeEach(() => {
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("loads validated models once and caches them in process", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(catalogPayload()));
    const catalog = await import("./nvidia-speech-catalog.js");
    await catalog.warmNvidiaSpeechCatalog();

    const asr = catalog.resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });
    const tts = catalog.resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_TTS_MODEL_ID,
      modality: "tts",
    });
    const defaultAsr = catalog.resolveNvidiaSpeechCatalogDefault({
      modality: "asr",
      key: "english",
    });

    expect(asr?.cloud).toMatchObject({ transport: "http", functionId: ASR_FUNCTION_ID });
    expect(tts?.cloud).toMatchObject({ transport: "http", functionId: TTS_FUNCTION_ID });
    expect(defaultAsr?.id).toBe(NVIDIA_CATALOG_ASR_MODEL_ID);
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: NVIDIA_SPEECH_CATALOG_URL,
        timeoutMs: 3_000,
        policy: { allowedHostnames: ["raw.githubusercontent.com"] },
      }),
    );
  });

  it("rejects an invocation URL that does not match its function UUID", async () => {
    const payload = catalogPayload();
    payload.models[0]!.cloud.baseUrl = "https://speech.example";
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(payload));
    const catalog = await import("./nvidia-speech-catalog.js");
    await catalog.warmNvidiaSpeechCatalog();

    expect(
      catalog.resolveNvidiaSpeechCatalogModel({
        id: NVIDIA_CATALOG_ASR_MODEL_ID,
        modality: "asr",
      }),
    ).toBeUndefined();
  });

  it("rejects untrusted gRPC routing data", async () => {
    const payload = catalogPayload();
    payload.models[3]!.cloud.server = "grpc.attacker.example:443";
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(payload));
    const catalog = await import("./nvidia-speech-catalog.js");
    await catalog.warmNvidiaSpeechCatalog();

    expect(
      catalog.resolveNvidiaSpeechCatalogModel({
        id: NVIDIA_CATALOG_ASR_MODEL_ID,
        modality: "asr",
      }),
    ).toBeUndefined();
  });

  it("accepts only the pinned NVIDIA realtime session and WebSocket URLs", async () => {
    const payload = catalogPayload();
    payload.models[2]!.cloud.realtime!.websocketUrl = "wss://attacker.example/realtime";
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(payload));
    const catalog = await import("./nvidia-speech-catalog.js");
    await catalog.warmNvidiaSpeechCatalog();

    expect(
      catalog.resolveNvidiaSpeechCatalogModel({
        id: NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
        modality: "asr",
      }),
    ).toBeUndefined();
  });

  it("never fetches the remote catalog during request dispatch", async () => {
    const catalog = await import("./nvidia-speech-catalog.js");
    const beforeWarmup = catalog.resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });
    expect(beforeWarmup).toBeUndefined();
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();

    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(catalogPayload()));
    await catalog.warmNvidiaSpeechCatalog();
    const afterWarmup = catalog.resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });
    expect(afterWarmup?.id).toBe(NVIDIA_CATALOG_ASR_MODEL_ID);
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });

  it("keeps compiled routing available when setup warmup fails", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValue(new Error("network unavailable"));
    const catalog = await import("./nvidia-speech-catalog.js");
    await catalog.warmNvidiaSpeechCatalog();

    expect(
      catalog.resolveNvidiaSpeechCatalogModel({
        id: NVIDIA_CATALOG_ASR_MODEL_ID,
        modality: "asr",
      }),
    ).toBeUndefined();

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });
});
