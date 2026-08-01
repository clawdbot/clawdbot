/**
 * image_generate action helpers.
 *
 * Handles provider listing, task status, and duplicate-guard output for the image generation tool.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listRuntimeImageGenerationProviders } from "../../image-generation/runtime.js";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildImageGenerationTaskStatusListDetails,
  buildImageGenerationTaskStatusListText,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findActiveImageGenerationTaskForSession,
  findDuplicateGuardImageGenerationTaskForSession,
  listActiveImageGenerationTasksForSession,
} from "../image-generation-task-status.js";
import {
  createMediaGenerateDuplicateGuardResult,
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

type ImageGenerateActionResult = MediaGenerateActionResult;

/** Formats provider auth setup hints for the image generation `list` action. */
function formatImageGenerationAuthHint(provider: {
  id: string;
  authEnvVars: readonly string[];
}): string | undefined {
  if (provider.id === "openai") {
    return "set OPENAI_API_KEY or configure OpenAI Codex OAuth for openai/gpt-image-2";
  }
  if (provider.authEnvVars.length === 0) {
    return undefined;
  }
  return `set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`;
}

/** Lists supported image-generation modes exposed by a provider. */
function listSupportedImageGenerationModes(provider: ImageGenerationProvider): string[] {
  return ["generate", ...(provider.capabilities.edit.enabled ? ["edit"] : [])];
}

/** Formats provider capability details for the image generation `list` action. */
function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string {
  const caps: string[] = [];
  if (provider.capabilities.edit.enabled) {
    const modelLimits = Object.values(provider.capabilities.edit.maxInputImagesByModel ?? {})
      .concat(Object.values(provider.capabilities.edit.maxInputImagesByModelPrefix ?? {}))
      .filter((value) => Number.isFinite(value));
    const declaredLimits = [
      ...(typeof provider.capabilities.edit.maxInputImages === "number"
        ? [provider.capabilities.edit.maxInputImages]
        : []),
      ...modelLimits,
    ];
    const maxRefs = declaredLimits.length > 0 ? Math.max(...declaredLimits) : undefined;
    caps.push(
      `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}${modelLimits.length > 0 ? " depending on model" : ""}`,
    );
  }
  if ((provider.capabilities.geometry?.resolutions?.length ?? 0) > 0) {
    caps.push(`resolutions ${provider.capabilities.geometry?.resolutions?.join("/")}`);
  }
  if ((provider.capabilities.geometry?.sizes?.length ?? 0) > 0) {
    caps.push(`sizes ${provider.capabilities.geometry?.sizes?.join(", ")}`);
  }
  if ((provider.capabilities.geometry?.aspectRatios?.length ?? 0) > 0) {
    caps.push(`aspect ratios ${provider.capabilities.geometry?.aspectRatios?.join(", ")}`);
  }
  if ((provider.capabilities.output?.formats?.length ?? 0) > 0) {
    caps.push(`formats ${provider.capabilities.output?.formats?.join("/")}`);
  }
  if ((provider.capabilities.output?.backgrounds?.length ?? 0) > 0) {
    caps.push(`backgrounds ${provider.capabilities.output?.backgrounds?.join("/")}`);
  }
  return caps.join("; ");
}

/** Builds the image-generation provider listing result shown to the agent. */
export function createImageGenerateListActionResult(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ImageGenerateActionResult {
  const providers = listRuntimeImageGenerationProviders({ config: params.cfg });
  return createMediaGenerateProviderListActionResult({
    kind: "image_generation",
    providers,
    emptyText: "No image-generation providers are registered.",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    listModes: listSupportedImageGenerationModes,
    summarizeCapabilities: summarizeImageGenerationCapabilities,
    formatAuthHint: formatImageGenerationAuthHint,
  });
}

const imageGenerateTaskStatusActions = createMediaGenerateTaskStatusActions({
  inactiveText: "No active image generation task is currently running for this session.",
  findActiveTask: (sessionKey) => findActiveImageGenerationTaskForSession(sessionKey) ?? undefined,
  buildStatusText: buildImageGenerationTaskStatusText,
  buildStatusDetails: buildImageGenerationTaskStatusDetails,
});

/** Builds status output for active image-generation tasks in the current session. */
export function createImageGenerateStatusActionResult(
  sessionKey?: string,
): ImageGenerateActionResult {
  const activeTasks = listActiveImageGenerationTasksForSession(sessionKey);
  if (activeTasks.length > 1) {
    return {
      content: [{ type: "text", text: buildImageGenerationTaskStatusListText(activeTasks) }],
      details: {
        action: "status",
        ...buildImageGenerationTaskStatusListDetails(activeTasks),
      },
    };
  }
  return imageGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

/** Returns duplicate-guard status output when a matching image task is already active. */
export function createImageGenerateDuplicateGuardResult(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string },
): ImageGenerateActionResult | undefined {
  return createMediaGenerateDuplicateGuardResult({
    sessionKey,
    prompt: params?.prompt,
    requestKey: params?.requestKey,
    findDuplicateTask: findDuplicateGuardImageGenerationTaskForSession,
    buildStatusText: buildImageGenerationTaskStatusText,
    buildStatusDetails: buildImageGenerationTaskStatusDetails,
  });
}
