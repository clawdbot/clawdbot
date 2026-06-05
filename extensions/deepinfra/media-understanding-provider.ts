// Deepinfra provider module implements model/runtime integration.
import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_STT_FALLBACK_MODELS,
  DEEPINFRA_VLM_FALLBACK_MODELS,
} from "./media-models.js";
import type { DeepInfraSurfaceModel } from "./provider-models.js";

function resolveDefault(
  surfaceModels: readonly DeepInfraSurfaceModel[] | undefined,
  fallback: readonly string[],
): string {
  const first = surfaceModels?.[0]?.id;
  return first ?? fallback[0] ?? "";
}

export async function transcribeDeepInfraAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "deepinfra",
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    defaultModel: resolveDefault(undefined, DEEPINFRA_STT_FALLBACK_MODELS),
  });
}

// First entries of vlmModels / sttModels become the image / audio defaults.
export function buildDeepInfraMediaUnderstandingProvider(options?: {
  vlmModels?: readonly DeepInfraSurfaceModel[];
  sttModels?: readonly DeepInfraSurfaceModel[];
}): MediaUnderstandingProvider {
  return {
    id: "deepinfra",
    capabilities: ["image", "audio"],
    defaultModels: {
      image: resolveDefault(options?.vlmModels, DEEPINFRA_VLM_FALLBACK_MODELS),
      audio: resolveDefault(options?.sttModels, DEEPINFRA_STT_FALLBACK_MODELS),
    },
    autoPriority: {
      image: 45,
      audio: 45,
    },
    transcribeAudio: transcribeDeepInfraAudio,
    describeImage: describeImageWithModel,
    describeImages: describeImagesWithModel,
  };
}

// Back-compat const for callers not yet on the builder. Static fallback only.
export const deepinfraMediaUnderstandingProvider: MediaUnderstandingProvider =
  buildDeepInfraMediaUnderstandingProvider();
