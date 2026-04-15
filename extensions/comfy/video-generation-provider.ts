import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_COMFY_MODEL,
  _setComfyFetchGuardForTesting,
  isComfyCapabilityConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

export { _setComfyFetchGuardForTesting };

function toComfyInputImage(inputImage?: VideoGenerationSourceAsset) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer || !inputImage.mimeType) {
    throw new Error("Comfy video generation requires a local reference image file");
  }
  return {
    buffer: inputImage.buffer,
    mimeType: inputImage.mimeType,
    fileName: inputImage.fileName,
  };
}

export function buildComfyVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "comfy",
    label: "ComfyUI",
    defaultModel: DEFAULT_COMFY_MODEL,
    models: [DEFAULT_COMFY_MODEL],
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        cfg,
        agentDir,
        capability: "video",
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsAudio: false,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsAudio: false,
        supportsWatermark: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Comfy video generation currently supports at most one reference image");
      }
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Comfy video generation does not support input videos");
      }

      const result = await runComfyWorkflow({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        prompt: req.prompt,
        model: req.model,
        timeoutMs: req.timeoutMs,
        capability: "video",
        outputKinds: ["gifs", "videos"],
        inputImage: toComfyInputImage(req.inputImages?.[0]),
      });

      const videos: GeneratedVideoAsset[] = result.assets.map((asset) => ({
        buffer: asset.buffer,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        metadata: {
          nodeId: asset.nodeId,
          promptId: result.promptId,
        },
      }));

      return {
        videos,
        model: result.model,
        metadata: {
          promptId: result.promptId,
          outputNodeIds: result.outputNodeIds,
        },
      };
    },
  };
}
