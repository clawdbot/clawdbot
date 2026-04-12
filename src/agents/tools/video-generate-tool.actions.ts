import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSupportedVideoGenerationModes } from "../../video-generation/capabilities.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
} from "../video-generation-task-status.js";
import {
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type VideoGenerateActionResult = MediaGenerateActionResult;

function summarizeVideoGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeVideoGenerationProviders>[number],
): string {
  const supportedModes = listSupportedVideoGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const imageToVideo = provider.capabilities.imageToVideo;
  const videoToVideo = provider.capabilities.videoToVideo;
  // providerOptions may be declared at the mode level (generate) or at the flat
  // provider-capabilities level. The runtime checks both; surface the union so
  // the agent sees a single merged view of which opaque keys each provider
  // actually accepts.
  const declaredProviderOptions: Record<string, string> = {};
  for (const [key, type] of Object.entries(provider.capabilities.providerOptions ?? {})) {
    declaredProviderOptions[key] = type;
  }
  for (const [key, type] of Object.entries(generate?.providerOptions ?? {})) {
    declaredProviderOptions[key] = type;
  }
  for (const [key, type] of Object.entries(imageToVideo?.providerOptions ?? {})) {
    declaredProviderOptions[key] = type;
  }
  for (const [key, type] of Object.entries(videoToVideo?.providerOptions ?? {})) {
    declaredProviderOptions[key] = type;
  }
  const maxInputAudios =
    generate?.maxInputAudios ??
    imageToVideo?.maxInputAudios ??
    videoToVideo?.maxInputAudios ??
    provider.capabilities.maxInputAudios;
  const capabilities = [
    supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
    generate?.maxVideos ? `maxVideos=${generate.maxVideos}` : null,
    imageToVideo?.maxInputImages ? `maxInputImages=${imageToVideo.maxInputImages}` : null,
    videoToVideo?.maxInputVideos ? `maxInputVideos=${videoToVideo.maxInputVideos}` : null,
    typeof maxInputAudios === "number" && maxInputAudios > 0
      ? `maxInputAudios=${maxInputAudios}`
      : null,
    generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
    generate?.supportedDurationSeconds?.length
      ? `supportedDurationSeconds=${generate.supportedDurationSeconds.join("/")}`
      : null,
    generate?.supportedDurationSecondsByModel &&
    Object.keys(generate.supportedDurationSecondsByModel).length > 0
      ? `supportedDurationSecondsByModel=${Object.entries(generate.supportedDurationSecondsByModel)
          .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
          .join("; ")}`
      : null,
    generate?.supportsResolution ? "resolution" : null,
    generate?.supportsAspectRatio ? "aspectRatio" : null,
    generate?.supportsSize ? "size" : null,
    generate?.supportsAudio ? "audio" : null,
    generate?.supportsWatermark ? "watermark" : null,
    Object.keys(declaredProviderOptions).length > 0
      ? `providerOptions={${Object.entries(declaredProviderOptions)
          .map(([key, type]) => `${key}:${type}`)
          .join(", ")}}`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(", ");
  return capabilities;
}

export function createVideoGenerateListActionResult(
  config?: OpenClawConfig,
): VideoGenerateActionResult {
  const providers = listRuntimeVideoGenerationProviders({ config });
  return createMediaGenerateProviderListActionResult({
    providers,
    emptyText: "No video-generation providers are registered.",
    listModes: listSupportedVideoGenerationModes,
    summarizeCapabilities: summarizeVideoGenerationCapabilities,
  });
}

const videoGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
  inactiveText: "No active video generation task is currently running for this session.",
  findActiveTask: (sessionKey) => findActiveVideoGenerationTaskForSession(sessionKey) ?? undefined,
  buildStatusText: buildVideoGenerationTaskStatusText,
  buildStatusDetails: buildVideoGenerationTaskStatusDetails,
});

export function createVideoGenerateStatusActionResult(
  sessionKey?: string,
): VideoGenerateActionResult {
  return videoGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

export function createVideoGenerateDuplicateGuardResult(
  sessionKey?: string,
): VideoGenerateActionResult | undefined {
  return videoGenerateTaskStatusActions.createDuplicateGuardResult(sessionKey);
}
