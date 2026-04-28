import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { encodePngRgba, fillPixel } from "openclaw/plugin-sdk/media-runtime";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { runRealtimeSttLiveTest } from "openclaw/plugin-sdk/provider-test-contracts";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { XAI_DEFAULT_STT_MODEL } from "./stt.js";

const XAI_API_KEY = process.env.XAI_API_KEY ?? "";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_XAI_IMAGE_MODEL?.trim() || "grok-imagine-image";
const liveEnabled = XAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const EMPTY_AUTH_STORE = { version: 1, profiles: {} } as const;

function createLiveConfig(): OpenClawConfig {
  const cfg = getRuntimeConfig();
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        xai: {
          ...cfg.models?.providers?.xai,
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
        },
      },
    },
  } as OpenClawConfig;
}

function createReferencePng(): Buffer {
  const width = 96;
  const height = 96;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 230, 244, 255, 255);
    }
  }

  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

async function createTempAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "xai-plugin-live-"));
}

const registerXaiPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "xai",
    name: "xAI Provider",
  });

function normalizeTranscriptForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

describeLive("xai plugin live", () => {
  it("synthesizes TTS through the registered speech provider", async () => {
    const { speechProviders } = await registerXaiPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "xai");
    const cfg = createLiveConfig();

    const voices = await speechProvider.listVoices?.({});
    expect(voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "eve" })]));

    const audioFile = await speechProvider.synthesize({
      text: "OpenClaw xAI text to speech integration test OK.",
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
      },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.voiceCompatible).toBe(false);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    const telephony = await speechProvider.synthesizeTelephony?.({
      text: "OpenClaw xAI telephony check OK.",
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
      },
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("xAI telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("pcm");
    expect(telephony.sampleRate).toBe(24_000);
    expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("transcribes audio through the registered media provider", async () => {
    const { mediaProviders, speechProviders } = await registerXaiPlugin();
    const mediaProvider = requireRegisteredProvider(mediaProviders, "xai");
    const speechProvider = requireRegisteredProvider(speechProviders, "xai");
    const cfg = createLiveConfig();
    const phrase = "OpenClaw xAI speech to text integration test OK.";

    const audioFile = await speechProvider.synthesize({
      text: phrase,
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
      },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    const transcript = await mediaProvider.transcribeAudio?.({
      buffer: audioFile.audioBuffer,
      fileName: "xai-stt-live.mp3",
      mime: "audio/mpeg",
      apiKey: XAI_API_KEY,
      baseUrl: "https://api.x.ai/v1",
      model: XAI_DEFAULT_STT_MODEL,
      timeoutMs: 90_000,
    });

    const normalized = transcript?.text.toLowerCase() ?? "";
    const compact = normalizeTranscriptForMatch(normalized);
    expect(transcript?.model).toBe(XAI_DEFAULT_STT_MODEL);
    expect(compact).toContain("openclaw");
    expect(normalized).toContain("speech");
    expect(normalized).toContain("text");
    expect(normalized).toContain("integration");
  }, 180_000);

  it("opens xAI realtime STT before sending audio", async () => {
    const { realtimeTranscriptionProviders } = await registerXaiPlugin();
    const realtimeProvider = requireRegisteredProvider(realtimeTranscriptionProviders, "xai");
    const errors: Error[] = [];
    const session = realtimeProvider.createSession({
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        sampleRate: 16_000,
        encoding: "pcm",
        interimResults: true,
        endpointingMs: 800,
        language: "en",
      },
      onError: (error) => errors.push(error),
    });

    try {
      await session.connect();
      expect(errors).toEqual([]);
      expect(session.isConnected()).toBe(true);
    } finally {
      session.close();
    }
  }, 30_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const { realtimeTranscriptionProviders, speechProviders } = await registerXaiPlugin();
    const realtimeProvider = requireRegisteredProvider(realtimeTranscriptionProviders, "xai");
    const speechProvider = requireRegisteredProvider(speechProviders, "xai");
    const cfg = createLiveConfig();
    const phrase = "OpenClaw xAI realtime transcription integration test OK.";

    const telephony = await speechProvider.synthesizeTelephony?.({
      text: phrase,
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
      },
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("xAI telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("pcm");
    expect(telephony.sampleRate).toBe(24_000);

    const chunkSize = Math.max(1, Math.floor(telephony.sampleRate * 2 * 0.1));
    const { transcripts, partials } = await runRealtimeSttLiveTest({
      provider: realtimeProvider,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        sampleRate: telephony.sampleRate,
        encoding: "pcm",
        interimResults: true,
        endpointingMs: 500,
        language: "en",
      },
      audio: telephony.audioBuffer,
      chunkSize,
      delayMs: 20,
      closeBeforeWait: true,
    });

    const normalized = transcripts.join(" ").toLowerCase();
    const compact = normalizeTranscriptForMatch(normalized);
    expect(compact).toContain("openclaw");
    expect(normalized).toContain("transcription");
    expect(partials.length + transcripts.length).toBeGreaterThan(0);
  }, 180_000);

  it("generates and edits images through the registered image provider", async () => {
    const { imageProviders } = await registerXaiPlugin();
    const imageProvider = requireRegisteredProvider(imageProviders, "xai");
    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const generated = await imageProvider.generateImage({
        provider: "xai",
        model: LIVE_IMAGE_MODEL,
        prompt: "Create a minimal flat orange square centered on a white background.",
        cfg,
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        timeoutMs: 180_000,
        count: 1,
        aspectRatio: "1:1",
        resolution: "1K",
      });

      expect(generated.model).toBe(LIVE_IMAGE_MODEL);
      expect(generated.images.length).toBeGreaterThan(0);
      expect(generated.images[0]?.mimeType.startsWith("image/")).toBe(true);
      expect(generated.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);

      const edited = await imageProvider.generateImage({
        provider: "xai",
        model: LIVE_IMAGE_MODEL,
        prompt:
          "Render this image as a pencil sketch with detailed shading. Keep the same framing.",
        cfg,
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        timeoutMs: 180_000,
        count: 1,
        resolution: "1K",
        inputImages: [
          {
            buffer: createReferencePng(),
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });

      expect(edited.model).toBe(LIVE_IMAGE_MODEL);
      expect(edited.images.length).toBeGreaterThan(0);
      expect(edited.images[0]?.mimeType.startsWith("image/")).toBe(true);
      expect(edited.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 300_000);
});
