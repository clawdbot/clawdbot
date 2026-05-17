import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listRuntimeImageGenerationProviders } from "../../image-generation/runtime.js";
import type { ImageGenerationProvider } from "../../image-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findActiveImageGenerationTaskForSession,
} from "../image-generation-task-status.js";
import {
  createMediaGenerateProviderListActionResult,
  createMediaGenerateTaskStatusActions,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";

export type ImageGenerateActionResult = MediaGenerateActionResult;

export function formatImageGenerationAuthHint(provider: {
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

export function listSupportedImageGenerationModes(provider: ImageGenerationProvider): string[] {
  return ["generate", ...(provider.capabilities.edit.enabled ? ["edit"] : [])];
}

export function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string {
  const caps: string[] = [];
  if (provider.capabilities.edit.enabled) {
    const maxRefs = provider.capabilities.edit.maxInputImages;
    caps.push(
      `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}`,
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

export function createImageGenerateListActionResult(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ImageGenerateActionResult {
  const providers = listRuntimeImageGenerationProviders({ config: params.cfg });
  return createMediaGenerateProviderListActionResult({
    kind: "image_generation",
    providers,
    emptyText: "No image-generation providers are registered.",
    cfg: params.cfg,
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

export function createImageGenerateStatusActionResult(
  sessionKey?: string,
): ImageGenerateActionResult {
  return imageGenerateTaskStatusActions.createStatusActionResult(sessionKey);
}

export function createImageGenerateDuplicateGuardResult(
  sessionKey?: string,
): ImageGenerateActionResult | undefined {
  return imageGenerateTaskStatusActions.createDuplicateGuardResult(sessionKey);
}
