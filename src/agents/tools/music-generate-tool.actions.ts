import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildMusicGenerationTaskStatusDetails,
  buildMusicGenerationTaskStatusText,
  findActiveMusicGenerationTaskForSession,
} from "../music-generation-task-status.js";
import {
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type MusicGenerateActionResult = MediaGenerateActionResult;

function summarizeMusicGenerationCapabilities(
  provider: ReturnType<typeof listRuntimeMusicGenerationProviders>[number],
): string {
  const supportedModes = listSupportedMusicGenerationModes(provider);
  const generate = provider.capabilities.generate;
  const edit = provider.capabilities.edit;
  const capabilities = [
    supportedModes.length > 0 ? `modes=${supportedModes.join("/")}` : null,
    generate?.maxTracks ? `maxTracks=${generate.maxTracks}` : null,
    edit?.maxInputImages ? `maxInputImages=${edit.maxInputImages}` : null,
    generate?.maxDurationSeconds ? `maxDurationSeconds=${generate.maxDurationSeconds}` : null,
    generate?.supportsLyrics ? "lyrics" : null,
    generate?.supportsInstrumental ? "instrumental" : null,
    generate?.supportsDuration ? "duration" : null,
    generate?.supportsFormat ? "format" : null,
    generate?.supportedFormats?.length
      ? `supportedFormats=${generate.supportedFormats.join("/")}`
      : null,
    generate?.supportedFormatsByModel && Object.keys(generate.supportedFormatsByModel).length > 0
      ? `supportedFormatsByModel=${Object.entries(generate.supportedFormatsByModel)
          .map(([modelId, formats]) => `${modelId}:${formats.join("/")}`)
          .join("; ")}`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(", ");
  return capabilities;
}

export function createMusicGenerateListActionResult(
  config?: OpenClawConfig,
  options?: { agentDir?: string; authStore?: AuthProfileStore },
): MusicGenerateActionResult {
  const providers = listRuntimeMusicGenerationProviders({ config });
  return createMediaGenerateProviderListActionResult({
    kind: "music_generation",
    providers,
    emptyText: "No music-generation providers are registered.",
    cfg: config,
    agentDir: options?.agentDir,
    authStore: options?.authStore,
    listModes: listSupportedMusicGenerationModes,
    summarizeCapabilities: summarizeMusicGenerationCapabilities,
  });
}

const musicGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
  inactiveText: "No active music generation task is currently running for this session.",
  findActiveTask: (sessionKey) => findActiveMusicGenerationTaskForSession(sessionKey) ?? undefined,
  buildStatusText: buildMusicGenerationTaskStatusText,
  buildStatusDetails: buildMusicGenerationTaskStatusDetails,
});

export function createMusicGenerateStatusActionResult(
  sessionKey?: string,
): MusicGenerateActionResult {
  return musicGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

export function createMusicGenerateDuplicateGuardResult(
  sessionKey?: string,
): MusicGenerateActionResult | undefined {
  return musicGenerateTaskStatusActions.createDuplicateGuardResult(sessionKey);
}
