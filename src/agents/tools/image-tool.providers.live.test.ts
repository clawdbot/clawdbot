// Live image provider tests verify real provider calls downscale large local
// images before sending them to OpenAI or Anthropic.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelApi } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resizeToJpeg } from "../../media/media-services.js";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import {
  describeImageWithModel,
  type ImageDescriptionRequest,
  type MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import {
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
} from "../../plugin-sdk/test-env.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { isLiveAuthDrift } from "../live-test-provider-drift.js";
import { createImageTool, testing } from "./image-tool.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const LIVE_IMAGE_TOOL_ENABLED = isLiveTestEnabled(["OPENCLAW_LIVE_IMAGE_TOOL_TEST"]);
const LIVE_OPENAI_MODEL =
  process.env.OPENCLAW_LIVE_IMAGE_TOOL_OPENAI_MODEL?.trim() ||
  process.env.OPENCLAW_LIVE_IMAGE_TOOL_MODEL?.trim() ||
  "gpt-4.1-mini";
const LIVE_ANTHROPIC_MODEL =
  process.env.OPENCLAW_LIVE_IMAGE_TOOL_ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const MODEL_SIDE_LIMIT = 512;

type LiveProviderCase = {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  api: ModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  live: boolean;
};

const OPENAI_LIVE_CASE: LiveProviderCase = {
  provider: "openai",
  model: LIVE_OPENAI_MODEL,
  apiKey: OPENAI_API_KEY,
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_047_576,
  maxTokens: 32_768,
  reasoning: false,
  live: LIVE_IMAGE_TOOL_ENABLED && OPENAI_API_KEY.length > 0,
};

const ANTHROPIC_LIVE_CASE: LiveProviderCase = {
  provider: "anthropic",
  model: LIVE_ANTHROPIC_MODEL,
  apiKey: ANTHROPIC_API_KEY,
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com/v1",
  contextWindow: 200_000,
  maxTokens: 8192,
  reasoning: true,
  live: LIVE_IMAGE_TOOL_ENABLED && ANTHROPIC_API_KEY.length > 0,
};

function createLargeCenterRedPng(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4, 255);
  const centerStart = Math.floor(size * 0.25);
  const centerEnd = Math.floor(size * 0.75);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
      fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
    }
  }
  return encodePngRgba(buf, size, size);
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  // The provider hook receives JPEG bytes after optimization; parsing SOF
  // markers keeps the downscale proof independent from image libraries.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions not found");
}

function formatLiveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSkippableLiveError(error: unknown): boolean {
  const message = formatLiveError(error);
  return (
    isBillingErrorMessage(message) ||
    isLiveAuthDrift(message) ||
    isOverloadedErrorMessage(message) ||
    isServerErrorMessage(message) ||
    /timed out|operation was aborted/i.test(message)
  );
}

function createLiveConfig(testCase: LiveProviderCase): OpenClawConfig {
  return {
    agents: {
      defaults: {
        imageModel: { primary: `${testCase.provider}/${testCase.model}` },
        imageQuality: "high",
      },
    },
    models: {
      providers: {
        [testCase.provider]: {
          apiKey: testCase.apiKey,
          baseUrl: testCase.baseUrl,
          api: testCase.api,
          models: [
            {
              id: testCase.model,
              name: testCase.model,
              reasoning: testCase.reasoning,
              input: ["text", "image"],
              contextWindow: testCase.contextWindow,
              maxTokens: testCase.maxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: MODEL_SIDE_LIMIT, preferredSidePx: MODEL_SIDE_LIMIT },
              },
            },
          ],
        },
      },
    },
    tools: {
      media: {
        image: {
          timeoutSeconds: 90,
          models: [{ provider: testCase.provider, model: testCase.model, timeoutSeconds: 90 }],
        },
      },
    },
  };
}

async function withLiveWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string; imagePath: string }) => Promise<T>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-tool-live-"));
  try {
    const agentDir = path.join(root, "agent");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    const sourcePng = createLargeCenterRedPng(2200);
    const sourceJpeg = await resizeToJpeg({
      buffer: sourcePng,
      maxSide: 2200,
      quality: 92,
      withoutEnlargement: true,
    });
    const sourceDimensions = readJpegDimensions(sourceJpeg);
    expect(Math.max(sourceDimensions.width, sourceDimensions.height)).toBeGreaterThan(
      MODEL_SIDE_LIMIT,
    );
    const imagePath = path.join(workspaceDir, "large-center-red.jpg");
    await fs.writeFile(imagePath, sourceJpeg);
    return await run({ agentDir, workspaceDir, imagePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  testing.setProviderDepsForTest();
});

async function runLiveDownscaleCase(testCase: LiveProviderCase) {
  let observedDimensions: { width: number; height: number } | undefined;
  testing.setProviderDepsForTest({
    getMediaUnderstandingProvider: (
      _id: string,
      _registry: Map<string, MediaUnderstandingProvider>,
    ) => undefined,
    describeImageWithModel: async (params: ImageDescriptionRequest) => {
      expect(params.provider).toBe(testCase.provider);
      expect(params.model).toBe(testCase.model);
      expect(params.mime).toBe("image/jpeg");
      observedDimensions = readJpegDimensions(params.buffer);
      expect(Math.max(observedDimensions.width, observedDimensions.height)).toBeLessThanOrEqual(
        MODEL_SIDE_LIMIT,
      );
      return await describeImageWithModel(params);
    },
  });

  await withLiveWorkspace(async ({ agentDir, workspaceDir, imagePath }) => {
    const tool = createImageTool({
      config: createLiveConfig(testCase),
      agentDir,
      workspaceDir,
    });
    if (!tool) {
      throw new Error("expected image tool");
    }

    let result: unknown;
    try {
      result = await tool.execute(`live-${testCase.provider}-large-image`, {
        prompt:
          "Look at the center of the image. Reply with one lowercase word naming that center color.",
        image: imagePath,
      });
    } catch (err) {
      if (isSkippableLiveError(err)) {
        console.warn(`[live:image-tool:${testCase.provider}] skipped: ${formatLiveError(err)}`);
        return;
      }
      throw err;
    }

    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    const text = content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text?.toLowerCase() ?? "")
      .join(" ");
    expect(text).toMatch(/red|crimson|orange/);
    expect(observedDimensions).toBeDefined();
  });
}

describe.skipIf(!OPENAI_LIVE_CASE.live)("image tool OpenAI live", () => {
  it("downscales a large local image before sending it to the live vision model", async () => {
    await runLiveDownscaleCase(OPENAI_LIVE_CASE);
  }, 180_000);
});

describe.skipIf(!ANTHROPIC_LIVE_CASE.live)("image tool Anthropic live", () => {
  it("downscales a large local image before sending it to the live vision model", async () => {
    await runLiveDownscaleCase(ANTHROPIC_LIVE_CASE);
  }, 180_000);
});
