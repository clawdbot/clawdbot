// Regression tests for custom image providers whose credentials live in
// models.json rather than environment variables or auth profiles.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { ImageDescriptionRequest } from "../../plugin-sdk/media-understanding.js";
import { getApiKeyForModel, hasUsableCustomProviderApiKey } from "../model-auth.js";
import { resolveImageToolFactoryAvailable } from "../openclaw-tools.media-factory-plan.js";
import { createImageTool } from "./image-tool.js";
import { resolveImageModelConfigForTool, testing } from "./image-tool.test-support.js";
import { hasProviderAuthForTool } from "./model-config.helpers.js";

const USER_PROVIDER = "hatchery-qwen3.6-plus";
const USER_MODEL = "qwen3.6-plus";
const USER_PRIMARY = `${USER_PROVIDER}/${USER_MODEL}`;
const BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_VISION_MODEL = "vision-1";
const CONFIG_API_KEY = "sk-user-configured-key"; // pragma: allowlist secret
const USER_PROVIDER_AUTH_ENV_KEYS = [
  "HATCHERY_QWEN3_6_PLUS_API_KEY",
  "HATCHERY_QWEN3_6_PLUS_OAUTH_TOKEN",
  "QWEN3_6_PLUS_API_KEY",
  "QWEN3_6_PLUS_OAUTH_TOKEN",
];
const mediaRuntimeMock = {
  loadWebMedia: vi.fn(async () => ({
    buffer: Buffer.from("fixture-image"),
    contentType: "image/png",
    kind: "image" as const,
  })),
  optimizeImageBufferForWebMedia: vi.fn(
    async (params: { buffer: Buffer; contentType?: string; fileName?: string }) => ({
      buffer: params.buffer,
      contentType: params.contentType ?? "image/png",
      kind: "image" as const,
      fileName: params.fileName,
    }),
  ),
};

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBBsGAQr00ED3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTI3VDA2OjAxOjEwKzAwOjAwPU3tXwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0yN1QwNjowMToxMCswMDowMEwQVeMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMjdUMDY6MDE6MTArMDA6MDAbBXQ8AAAAeElEQVRo3u3awQnDQBAEwT2Q8w/YAikIP5rF1RFMca+FO8/s7rrnqjcA1BsA6g0A9QaAesOfA77zqTf8Blj/AgAAAAAAAJsDqAOoA6gDqAOoc9TXAdQB1AHUAdQB1AHUAdQB1AHU7Qc46gEAAAAANrcecGZ2f8B/ASYSQPlKoEJ/AAAAAElFTkSuQmCC";

function makeVisionModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function createUserReportedConfig(params?: { includeApiKey?: boolean }): OpenClawConfig {
  const includeApiKey = params?.includeApiKey ?? true;
  return {
    agents: {
      defaults: {
        model: { primary: USER_PRIMARY },
      },
    },
    models: {
      providers: {
        [USER_PROVIDER]: {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          ...(includeApiKey ? { apiKey: CONFIG_API_KEY } : {}),
          models: [makeVisionModel(USER_MODEL)],
        },
      },
    },
  };
}

function createBedrockSdkConfig(): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: `${BEDROCK_PROVIDER}/text-1` } } },
    models: {
      mode: "replace",
      providers: {
        [BEDROCK_PROVIDER]: {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          auth: "aws-sdk",
          api: "bedrock-converse-stream",
          models: [makeVisionModel(BEDROCK_VISION_MODEL)],
        },
      },
    },
  };
}

async function withEmptyAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-auth-regression-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("image custom provider auth regression", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    mediaRuntimeMock.loadWebMedia.mockClear();
    mediaRuntimeMock.optimizeImageBufferForWebMedia.mockClear();
    for (const key of USER_PROVIDER_AUTH_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      describeImageWithModel: async (params: ImageDescriptionRequest) => ({
        text: `seen:${params.provider}/${params.model}`,
        model: params.model,
      }),
      describeImagesWithModel: async (params) => ({
        text: `seen:${params.provider}/${params.model}`,
        model: params.model,
      }),
      resolveAutoMediaKeyProviders: () => [],
      resolveDefaultMediaModel: () => undefined,
      resolveModelAsync: async () => ({
        model: {} as never,
        authStorage: {} as never,
        modelRegistry: {} as never,
      }),
      loadImageWebMediaRuntime: async () => mediaRuntimeMock,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
    testing.setProviderDepsForTest(undefined);
  });

  it("uses real model-auth to accept config-only custom provider credentials", async () => {
    const cfg = createUserReportedConfig();
    expect(hasUsableCustomProviderApiKey(cfg, USER_PROVIDER)).toBe(true);
    expect(hasProviderAuthForTool({ provider: USER_PROVIDER, cfg })).toBe(true);
  });

  it("auto-discovers the user-reported vision model without env key or auth profile", async () => {
    await withEmptyAgentDir(async (agentDir) => {
      const cfg = createUserReportedConfig();
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: USER_PRIMARY,
      });
    });
  });

  it("registers the image tool on the production factory path when the primary model has vision", async () => {
    await withEmptyAgentDir(async (agentDir) => {
      const cfg = createUserReportedConfig();
      expect(
        resolveImageToolFactoryAvailable({
          config: cfg,
          agentDir,
          modelHasVision: true,
        }),
      ).toBe(true);
    });
  });

  it("registers config-only AWS SDK Bedrock image models", async () => {
    await withEmptyAgentDir(async (agentDir) => {
      vi.stubEnv("AWS_PROFILE", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      const cfg = createBedrockSdkConfig();

      expect(hasProviderAuthForTool({ provider: BEDROCK_PROVIDER, cfg })).toBe(true);
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: `${BEDROCK_PROVIDER}/${BEDROCK_VISION_MODEL}`,
      });
      expect(
        resolveImageToolFactoryAvailable({
          config: cfg,
          agentDir,
          modelHasVision: true,
        }),
      ).toBe(true);
    });
  });

  it("executes deferred fallback discovery with config-backed auth and runtime key resolution", async () => {
    // This covers the text-only fallback path: registration can avoid auth work,
    // but execution still resolves the config-backed image-model key.
    await withEmptyAgentDir(async (agentDir) => {
      const cfg = createUserReportedConfig();
      const auth = await getApiKeyForModel({
        model: {
          id: USER_MODEL,
          name: USER_MODEL,
          provider: USER_PROVIDER,
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        cfg,
        agentDir,
      });
      expect(auth.apiKey).toBe(CONFIG_API_KEY);
      expect(auth.source).toContain("models.json");

      const tool = createImageTool({
        config: cfg,
        agentDir,
        deferAutoModelResolution: true,
        modelHasVision: false,
      });
      expect(typeof tool?.execute).toBe("function");

      const result = await tool!.execute("regression-1", {
        prompt: "Read this screenshot.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      const payload = result as { content?: Array<{ type?: string; text?: string }> };
      const text = payload.content?.find((entry) => entry.type === "text")?.text ?? "";
      expect(text).toContain(`seen:${USER_PRIMARY}`);
      expect(text).not.toMatch(/No image model is configured/i);
      expect(mediaRuntimeMock.optimizeImageBufferForWebMedia).toHaveBeenCalledTimes(1);
    });
  });

  it("still rejects the same fallback config when apiKey is missing", async () => {
    await withEmptyAgentDir(async (agentDir) => {
      const cfg = createUserReportedConfig({ includeApiKey: false });
      expect(hasUsableCustomProviderApiKey(cfg, USER_PROVIDER)).toBe(false);
      expect(hasProviderAuthForTool({ provider: USER_PROVIDER, cfg })).toBe(false);
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();

      const tool = createImageTool({
        config: cfg,
        agentDir,
        deferAutoModelResolution: true,
        modelHasVision: false,
      });
      await expect(
        tool!.execute("regression-2", {
          prompt: "Read this screenshot.",
          image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        }),
      ).rejects.toThrow(/No image model is configured/);
    });
  });
});
