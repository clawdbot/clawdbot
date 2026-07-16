import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "openclaw/plugin-sdk/music-generation";
import {
  DEFAULT_COMFY_MODEL,
  isComfyCapabilityConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

const COMFY_MAX_INPUT_IMAGES = 1;

function toGeneratedTrack(asset: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): GeneratedMusicAsset {
  return {
    buffer: asset.buffer,
    mimeType: asset.mimeType,
    fileName: asset.fileName,
  };
}

function resolveInputImage(inputImage: MusicGenerationSourceImage | undefined) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer) {
    throw new Error("Comfy music generation requires loaded reference image bytes.");
  }
  return {
    buffer: inputImage.buffer,
    mimeType: inputImage.mimeType ?? "image/png",
    fileName: inputImage.fileName,
  };
}

export function buildComfyMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "comfy",
    label: "ComfyUI",
    defaultModel: DEFAULT_COMFY_MODEL,
    models: [DEFAULT_COMFY_MODEL],
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        cfg,
        agentDir,
        capability: "music",
      }),
    capabilities: {
      generate: {},
      edit: {
        enabled: true,
        maxInputImages: COMFY_MAX_INPUT_IMAGES,
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > COMFY_MAX_INPUT_IMAGES) {
        throw new Error(
          `Comfy music generation supports at most ${COMFY_MAX_INPUT_IMAGES} reference image.`,
        );
      }

      const result = await runComfyWorkflow({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        prompt: req.prompt,
        model: req.model,
        capability: "music",
        outputKinds: ["audio"],
        inputImage: resolveInputImage(req.inputImages?.[0]),
      });

      return {
        tracks: result.assets.map(toGeneratedTrack),
        model: result.model,
        metadata: {
          promptId: result.promptId,
          outputNodeIds: result.outputNodeIds,
          inputImageCount: req.inputImages?.length ?? 0,
        },
      };
    },
  };
}
