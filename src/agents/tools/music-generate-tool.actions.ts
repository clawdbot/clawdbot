/**
 * music_generate action helpers.
 *
 * Handles provider listing, task status, and duplicate-guard output for the music generation tool.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSupportedMusicGenerationModes } from "../../music-generation/capabilities.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildMusicGenerationTaskStatusDetails,
  buildMusicGenerationTaskStatusText,
  findActiveMusicGenerationTaskForSession,
  findDuplicateGuardMusicGenerationTaskForSession,
} from "../music-generation-task-status.js";
import {
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type MusicGenerateActionResult = MediaGenerateActionResult;

/** Formats provider capability details for the music generation `list` action. */
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
    generate?.supportsLyricsByModel && Object.keys(generate.supportsLyricsByModel).length > 0
      ? `supportsLyricsByModel=${Object.entries(generate.supportsLyricsByModel)
          .map(([modelId, supported]) => `${modelId}:${supported}`)
          .join("; ")}`
      : null,
    generate?.supportsInstrumental ? "instrumental" : null,
    generate?.supportsInstrumentalByModel &&
    Object.keys(generate.supportsInstrumentalByModel).length > 0
      ? `supportsInstrumentalByModel=${Object.entries(generate.supportsInstrumentalByModel)
          .map(([modelId, supported]) => `${modelId}:${supported}`)
          .join("; ")}`
      : null,
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

/** Builds the music-generation provider listing result shown to the agent. */
export function createMusicGenerateListActionResult(
  config?: OpenClawConfig,
  options?: { workspaceDir?: string; agentDir?: string; authStore?: AuthProfileStore },
): MusicGenerateActionResult {
  const providers = listRuntimeMusicGenerationProviders({ config });
  return createMediaGenerateProviderListActionResult({
    kind: "music_generation",
    providers,
    emptyText: "No music-generation providers are registered.",
    cfg: config,
    workspaceDir: options?.workspaceDir,
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

/** Builds status output for the active music-generation task in the current session. */
export function createMusicGenerateStatusActionResult(
  sessionKey?: string,
): MusicGenerateActionResult {
  return musicGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

/** Returns duplicate-guard status output when a matching music task is already active. */
export function createMusicGenerateDuplicateGuardResult(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string },
): MusicGenerateActionResult | undefined {
  const blockingTask = findDuplicateGuardMusicGenerationTaskForSession(sessionKey, {
    prompt: params?.prompt,
    requestKey: params?.requestKey,
  });
  if (!blockingTask) {
    return undefined;
  }
  return {
    content: [
      {
        type: "text",
        text: buildMusicGenerationTaskStatusText(blockingTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...buildMusicGenerationTaskStatusDetails(blockingTask),
    },
  };
}
