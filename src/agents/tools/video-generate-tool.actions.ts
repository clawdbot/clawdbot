/**
 * video_generate action result helpers.
 *
 * Formats provider listing, active-task status, and duplicate-guard responses for the tool.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSupportedVideoGenerationModes } from "../../video-generation/capabilities.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  findDuplicateGuardVideoGenerationTaskForSession,
} from "../video-generation-task-status.js";
import {
  createMediaGenerateDuplicateGuardResult,
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type VideoGenerateActionResult = MediaGenerateActionResult;

function summarizeVideoGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeVideoGenerationProviders>[number],
  options?: { modes?: readonly string[]; includeModes?: boolean },
): string {
  const supportedModes = options?.modes ?? listSupportedVideoGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const imageToVideo = provider.capabilities.imageToVideo;
  const videoToVideo = provider.capabilities.videoToVideo;
  const activeModeCapabilities = [
    supportedModes.includes("generate") ? generate : undefined,
    supportedModes.includes("imageToVideo") && imageToVideo?.enabled ? imageToVideo : undefined,
    supportedModes.includes("videoToVideo") && videoToVideo?.enabled ? videoToVideo : undefined,
  ].filter((capabilities) => capabilities !== undefined);
  const maxDurationSeconds = activeModeCapabilities
    .map((capabilities) => capabilities.maxDurationSeconds)
    .find((value) => typeof value === "number");
  const supportedDurationSeconds = activeModeCapabilities
    .map((capabilities) => capabilities.supportedDurationSeconds)
    .find((value) => value && value.length > 0);
  const supportedDurationSecondsByModel = activeModeCapabilities
    .map((capabilities) => capabilities.supportedDurationSecondsByModel)
    .find((value) => value && Object.keys(value).length > 0);
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
    options?.includeModes !== false && supportedModes.length > 0
      ? `modes=${supportedModes.join("/")}`
      : null,
    generate?.maxVideos ? `maxVideos=${generate.maxVideos}` : null,
    imageToVideo?.maxInputImages ? `maxInputImages=${imageToVideo.maxInputImages}` : null,
    videoToVideo?.maxInputVideos ? `maxInputVideos=${videoToVideo.maxInputVideos}` : null,
    typeof maxInputAudios === "number" && maxInputAudios > 0
      ? `maxInputAudios=${maxInputAudios}`
      : null,
    maxDurationSeconds ? `maxDurationSeconds=${maxDurationSeconds}` : null,
    supportedDurationSeconds
      ? `supportedDurationSeconds=${supportedDurationSeconds.join("/")}`
      : null,
    supportedDurationSecondsByModel
      ? `supportedDurationSecondsByModel=${Object.entries(supportedDurationSecondsByModel)
          .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
          .join("; ")}`
      : null,
    activeModeCapabilities.some((modeCapabilities) => modeCapabilities.supportsResolution)
      ? "resolution"
      : null,
    activeModeCapabilities.some((modeCapabilities) => modeCapabilities.supportsAspectRatio)
      ? "aspectRatio"
      : null,
    activeModeCapabilities.some((modeCapabilities) => modeCapabilities.supportsSize)
      ? "size"
      : null,
    activeModeCapabilities.some((modeCapabilities) => modeCapabilities.supportsAudio)
      ? "audio"
      : null,
    activeModeCapabilities.some((modeCapabilities) => modeCapabilities.supportsWatermark)
      ? "watermark"
      : null,
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
  options?: { workspaceDir?: string; agentDir?: string; authStore?: AuthProfileStore },
): VideoGenerateActionResult {
  const providers = listRuntimeVideoGenerationProviders({ config });
  return createMediaGenerateProviderListActionResult({
    kind: "video_generation",
    providers,
    emptyText: "No video-generation providers are registered.",
    cfg: config,
    workspaceDir: options?.workspaceDir,
    agentDir: options?.agentDir,
    authStore: options?.authStore,
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
  params?: { prompt?: string; requestKey?: string },
): VideoGenerateActionResult | undefined {
  return createMediaGenerateDuplicateGuardResult({
    sessionKey,
    prompt: params?.prompt,
    requestKey: params?.requestKey,
    findDuplicateTask: findDuplicateGuardVideoGenerationTaskForSession,
    buildStatusText: buildVideoGenerationTaskStatusText,
    buildStatusDetails: buildVideoGenerationTaskStatusDetails,
  });
}
