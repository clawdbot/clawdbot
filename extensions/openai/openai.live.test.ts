import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import OpenAI from "openai";
import type { ResolvedTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { encodePngRgba, fillPixel } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_PLUGIN_MODEL?.trim() || "gpt-5.4-nano";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
const LIVE_VISION_MODEL = process.env.OPENCLAW_LIVE_OPENAI_VISION_MODEL?.trim() || "gpt-4.1-mini";
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const EMPTY_AUTH_STORE = { version: 1, profiles: {} } as const;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

function resolveTemplateModelId(modelId: string) {
  switch (modelId) {
    case "gpt-5.4":
      return "gpt-5.2";
    case "gpt-5.4-mini":
      return "gpt-5-mini";
    case "gpt-5.4-nano":
      return "gpt-5-nano";
    default:
      throw new Error(`Unsupported live OpenAI plugin model: ${modelId}`);
  }
}

function createTemplateModelRegistry(modelId: string): ModelRegistry {
  const registry = new ModelRegistryCtor(AuthStorage.inMemory());
  const template = getModel("openai", resolveTemplateModelId(modelId));
  registry.registerProvider("openai", {
    apiKey: "test",
    baseUrl: template.baseUrl,
    models: [
      {
        id: template.id,
        name: template.name,
        api: template.api,
        reasoning: template.reasoning,
        input: template.input,
        cost: template.cost,
        contextWindow: template.contextWindow,
        maxTokens: template.maxTokens,
        ...(template.compat ? { compat: template.compat } : {}),
      },
    ],
  });
  return registry;
}

const registerOpenAIPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "openai",
    name: "OpenAI Provider",
  });

function createReferencePng(): Buffer {
  const width = 96;
  const height = 96;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 225, 242, 255, 255);
    }
  }

  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function createLiveConfig(): OpenClawConfig {
  const cfg = loadConfig();
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        openai: {
          ...cfg.models?.providers?.openai,
          apiKey: OPENAI_API_KEY,
          baseUrl: "https://api.openai.com/v1",
        },
      },
    },
  } as OpenClawConfig;
}

function createLiveTtsConfig(): ResolvedTtsConfig {
  return {
    auto: "off",
    mode: "final",
    provider: "openai",
    providerSource: "config",
    modelOverrides: {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    },
    providerConfigs: {
      openai: {
        apiKey: OPENAI_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
    maxTextLength: 4_000,
    timeoutMs: 30_000,
  };
}

async function createTempAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openai-plugin-live-"));
}

describeLive("openai plugin live", () => {
  it("registers an OpenAI provider that can complete a live request", async () => {
    const { providers } = await registerOpenAIPlugin();
    const provider = requireRegisteredProvider(providers, "openai");

    const resolved = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: LIVE_MODEL_ID,
      modelRegistry: createTemplateModelRegistry(LIVE_MODEL_ID),
    });

    if (!resolved) {
      throw new Error("openai provider did not resolve the live model");
    }

    const normalized = provider.normalizeResolvedModel?.({
      provider: "openai",
      modelId: resolved.id,
      model: resolved,
    });

    expect(normalized).toMatchObject({
      provider: "openai",
      id: LIVE_MODEL_ID,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: normalized?.baseUrl,
    });
    const response = await client.responses.create({
      model: normalized?.id ?? LIVE_MODEL_ID,
      input: "Reply with exactly OK.",
      max_output_tokens: 16,
    });

    expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);

  it("lists voices and synthesizes audio through the registered speech provider", async () => {
    const { speechProviders } = await registerOpenAIPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "openai");

    const voices = await speechProvider.listVoices?.({});
    if (!voices) {
      throw new Error("openai speech provider did not return voices");
    }
    expect(voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "alloy" })]));

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    const audioFile = await speechProvider.synthesize({
      text: "OpenClaw integration test OK.",
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      target: "audio-file",
      timeoutMs: ttsConfig.timeoutMs,
    });
    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    const telephony = await speechProvider.synthesizeTelephony?.({
      text: "Telephony check OK.",
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      timeoutMs: ttsConfig.timeoutMs,
    });
    expect(telephony?.outputFormat).toBe("pcm");
    expect(telephony?.sampleRate).toBe(24_000);
    expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 45_000);

  it("transcribes synthesized speech through the registered media provider", async () => {
    const { speechProviders, mediaProviders } = await registerOpenAIPlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "openai");
    const mediaProvider = requireRegisteredProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    const synthesized = await speechProvider.synthesize({
      text: "OpenClaw integration test OK.",
      cfg,
      providerConfig: ttsConfig.providerConfigs.openai ?? {},
      target: "audio-file",
      timeoutMs: ttsConfig.timeoutMs,
    });

    const transcription = await mediaProvider.transcribeAudio?.({
      buffer: synthesized.audioBuffer,
      fileName: "openai-plugin-live.mp3",
      mime: "audio/mpeg",
      apiKey: OPENAI_API_KEY,
      timeoutMs: 30_000,
    });

    const text = (transcription?.text ?? "").toLowerCase();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("openclaw");
    expect(text).toMatch(/\bok\b/);
  }, 45_000);

  it("generates an image through the registered image provider", async () => {
    const { imageProviders } = await registerOpenAIPlugin();
    const imageProvider = requireRegisteredProvider(imageProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const generated = await imageProvider.generateImage({
        provider: "openai",
        model: LIVE_IMAGE_MODEL,
        prompt: "Create a minimal flat orange square centered on a white background.",
        cfg,
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        timeoutMs: 45_000,
        size: "1024x1024",
      });

      expect(generated.model).toBe(LIVE_IMAGE_MODEL);
      expect(generated.images.length).toBeGreaterThan(0);
      expect(generated.images[0]?.mimeType).toBe("image/png");
      expect(generated.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("edits a reference image through the registered image provider", async () => {
    const { imageProviders } = await registerOpenAIPlugin();
    const imageProvider = requireRegisteredProvider(imageProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const edited = await imageProvider.generateImage({
        provider: "openai",
        model: LIVE_IMAGE_MODEL,
        prompt:
          "Edit this image: remove the orange square in the center and keep the background clean and light blue.",
        cfg,
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        timeoutMs: 45_000,
        size: "1024x1024",
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
      expect(edited.images[0]?.mimeType).toBe("image/png");
      expect(edited.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("describes a deterministic image through the registered media provider", async () => {
    const { mediaProviders } = await registerOpenAIPlugin();
    const mediaProvider = requireRegisteredProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      const description = await mediaProvider.describeImage?.({
        buffer: createReferencePng(),
        fileName: "reference.png",
        mime: "image/png",
        prompt: "Reply with one lowercase word for the dominant center color.",
        timeoutMs: 30_000,
        agentDir,
        cfg,
        model: LIVE_VISION_MODEL,
        provider: "openai",
      });

      expect((description?.text ?? "").toLowerCase()).toContain("orange");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 60_000);
});
