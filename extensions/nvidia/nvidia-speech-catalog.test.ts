import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard };
});

import {
  NVIDIA_CATALOG_ASR_MODEL_ID,
  NVIDIA_CATALOG_TTS_MODEL_ID,
  NVIDIA_SPEECH_CATALOG_URL,
  resetNvidiaSpeechCatalogCacheForTests,
  resolveNvidiaSpeechCatalogDefault,
  resolveNvidiaSpeechCatalogModel,
} from "./nvidia-speech-catalog.js";

const ASR_FUNCTION_ID = "1598d209-5e27-4d3c-8079-4751568b1081";
const TTS_FUNCTION_ID = "877104f7-e885-42b9-8de8-f6e4c6303969";

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
    resetNvidiaSpeechCatalogCacheForTests();
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    vi.restoreAllMocks();
  });

  it("loads validated models once and caches them in process", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(catalogPayload()));

    const asr = await resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });
    const tts = await resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_TTS_MODEL_ID,
      modality: "tts",
    });
    const defaultAsr = await resolveNvidiaSpeechCatalogDefault({
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

    await expect(
      resolveNvidiaSpeechCatalogModel({ id: NVIDIA_CATALOG_ASR_MODEL_ID, modality: "asr" }),
    ).resolves.toBeUndefined();
  });

  it("rejects untrusted gRPC routing data", async () => {
    const payload = catalogPayload();
    payload.models[2]!.cloud.server = "grpc.attacker.example:443";
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue(catalogResponse(payload));

    await expect(
      resolveNvidiaSpeechCatalogModel({ id: NVIDIA_CATALOG_ASR_MODEL_ID, modality: "asr" }),
    ).resolves.toBeUndefined();
  });

  it("keeps the last valid catalog when a refresh fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce(catalogResponse(catalogPayload()));
    const first = await resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });

    vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1_000 + 2_000);
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const refreshed = await resolveNvidiaSpeechCatalogModel({
      id: NVIDIA_CATALOG_ASR_MODEL_ID,
      modality: "asr",
    });

    expect(refreshed).toEqual(first);
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("backs off after an initial fetch failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValue(new Error("network unavailable"));

    await expect(
      resolveNvidiaSpeechCatalogModel({ id: NVIDIA_CATALOG_ASR_MODEL_ID, modality: "asr" }),
    ).resolves.toBeUndefined();
    await expect(
      resolveNvidiaSpeechCatalogModel({ id: NVIDIA_CATALOG_ASR_MODEL_ID, modality: "asr" }),
    ).resolves.toBeUndefined();

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });
});
