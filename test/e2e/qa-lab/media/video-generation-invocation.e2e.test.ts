import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedModelRuntimeSnapshot } from "../../../../src/agents/prepared-model-runtime.js";
import { createVideoGenerateTool } from "../../../../src/agents/tools/video-generate-tool.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { resolveVideoGenerationModeCapabilities } from "../../../../src/video-generation/capabilities.js";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "../../../../src/video-generation/types.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

function createMp4Fixture(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

function createPreparedRuntime(providers: VideoGenerationProvider[]): PreparedModelRuntimeSnapshot {
  return {
    mediaCapabilityProviders: {
      videoGenerationProviders: providers,
    },
  } as unknown as PreparedModelRuntimeSnapshot;
}

function createConfig(primary: string, fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        mediaModels: {
          video: { primary, fallbacks },
        },
      },
    },
  };
}

function requireVideoTool(tool: ReturnType<typeof createVideoGenerateTool>) {
  if (!tool) {
    throw new Error("expected video_generate tool");
  }
  return tool;
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected video generation result details");
  }
  return result.details as Record<string, unknown>;
}

describe("video generation invocation QA", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("selects image-to-video fallback, forwards declared options, and persists video bytes", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-qa-video-invocation-"));
    const referenceBytes = createSolidPngBuffer(2, 2, { r: 32, g: 112, b: 224 });
    const referencePath = path.join(root, "reference.png");
    await fs.writeFile(referencePath, referenceBytes);

    const generatedVideo = createMp4Fixture();
    let primaryGenerateCalls = 0;
    let fallbackRequest: VideoGenerationRequest | undefined;
    const primaryProvider: VideoGenerationProvider = {
      id: "qa-limited-video",
      defaultModel: "limited-v1",
      models: ["limited-v1"],
      isConfigured: () => true,
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          providerOptions: { seed: "number", draft: "boolean" },
        },
      },
      resolveModelCapabilities: async () => ({
        imageToVideo: {
          enabled: false,
        },
      }),
      generateVideo: async () => {
        primaryGenerateCalls += 1;
        throw new Error("unsupported provider must be skipped before forwarding");
      },
    };
    const fallbackProvider: VideoGenerationProvider = {
      id: "qa-capable-video",
      defaultModel: "capable-v1",
      models: ["capable-v1"],
      isConfigured: () => true,
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          providerOptions: { seed: "number", draft: "boolean" },
        },
      },
      generateVideo: async (request) => {
        fallbackRequest = request;
        return {
          model: request.model,
          videos: [
            {
              buffer: generatedVideo,
              mimeType: "video/mp4",
              fileName: "provider-result.mp4",
            },
          ],
        };
      },
    };
    const providers = [primaryProvider, fallbackProvider];
    const config = createConfig("qa-limited-video/limited-v1", ["qa-capable-video/capable-v1"]);
    const providerOptions = { seed: 17, draft: true };

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = requireVideoTool(
        createVideoGenerateTool({
          config,
          agentDir: path.join(root, "agent"),
          workspaceDir: root,
          preparedModelRuntime: createPreparedRuntime(providers),
        }),
      );
      const result = await tool.execute("qa-video-invocation", {
        prompt: "Animate the reference image into a short QA clip.",
        image: referencePath,
        imageRoles: ["first_frame"],
        providerOptions,
        filename: "qa-selected-video.mp4",
      });
      const details = requireDetails(result);

      expect(primaryGenerateCalls).toBe(0);
      expect(fallbackRequest).toMatchObject({
        provider: "qa-capable-video",
        model: "capable-v1",
        providerOptions,
      });
      expect(
        resolveVideoGenerationModeCapabilities({
          provider: fallbackProvider,
          model: fallbackRequest?.model,
          inputImageCount: fallbackRequest?.inputImages?.length,
          inputVideoCount: fallbackRequest?.inputVideos?.length,
        }).mode,
      ).toBe("imageToVideo");
      expect(fallbackRequest?.inputImages).toEqual([
        {
          buffer: referenceBytes,
          mimeType: "image/png",
          fileName: "reference.png",
          role: "first_frame",
        },
      ]);
      expect(details.provider).toBe("qa-capable-video");
      expect(details.model).toBe("capable-v1");
      expect(details.count).toBe(1);
      expect(details.attempts).toEqual([
        {
          provider: "qa-limited-video",
          model: "limited-v1",
          error: expect.stringContaining(
            "does not support reference image inputs; skipping to avoid silent reference drop",
          ),
        },
      ]);

      const savedPaths = details.paths as string[];
      expect(savedPaths).toHaveLength(1);
      const savedPath = savedPaths[0];
      if (!savedPath) {
        throw new Error("expected saved video path");
      }
      const savedStat = await fs.stat(savedPath);
      expect(savedStat.isFile()).toBe(true);
      expect(savedStat.size).toBe(generatedVideo.byteLength);
      await expect(fs.readFile(savedPath)).resolves.toEqual(generatedVideo);
      expect(details.attachments).toEqual([
        expect.objectContaining({
          type: "video",
          path: savedPath,
          mimeType: "video/mp4",
          sizeBytes: generatedVideo.byteLength,
        }),
      ]);
    });
  });

  it("rejects unknown and wrong-typed provider options before provider invocation", async () => {
    let providerCalls = 0;
    const createProvider = (id: string, model: string): VideoGenerationProvider => ({
      id,
      defaultModel: model,
      models: [model],
      isConfigured: () => true,
      capabilities: {
        providerOptions: { seed: "number", draft: "boolean" },
      },
      generateVideo: async () => {
        providerCalls += 1;
        return {
          videos: [{ buffer: createMp4Fixture(), mimeType: "video/mp4" }],
        };
      },
    });
    const providers = [
      createProvider("qa-options-primary", "primary-v1"),
      createProvider("qa-options-fallback", "fallback-v1"),
    ];
    const tool = requireVideoTool(
      createVideoGenerateTool({
        config: createConfig("qa-options-primary/primary-v1", ["qa-options-fallback/fallback-v1"]),
        preparedModelRuntime: createPreparedRuntime(providers),
      }),
    );

    await expect(
      tool.execute("qa-video-options-unknown", {
        prompt: "Generate a QA clip.",
        providerOptions: { seed: 21, unknown_option: true },
      }),
    ).rejects.toThrow(/does not accept providerOptions keys: unknown_option/);
    await expect(
      tool.execute("qa-video-options-type", {
        prompt: "Generate another QA clip.",
        providerOptions: { seed: "twenty-one" },
      }),
    ).rejects.toThrow(/expects providerOptions\.seed to be a finite number, got string/);
    expect(providerCalls).toBe(0);
  });
});
