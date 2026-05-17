import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { IMAGE_GENERATION_TASK_KIND } from "../image-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;

export const imageGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "image_generate",
  taskKind: IMAGE_GENERATION_TASK_KIND,
  label: "Image generation",
  queuedProgressSummary: "Queued image generation",
  generatedLabel: "image",
  failureProgressSummary: "Image generation failed",
  eventSource: "image_generation",
  announceType: "image generation task",
  completionLabel: "image",
});

export const createImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.createTaskRun>
) => imageGenerationTaskLifecycle.createTaskRun(...params);

export const recordImageGenerationTaskProgress = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.recordTaskProgress>
) => imageGenerationTaskLifecycle.recordTaskProgress(...params);

export const completeImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.completeTaskRun>
) => imageGenerationTaskLifecycle.completeTaskRun(...params);

export const failImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.failTaskRun>
) => imageGenerationTaskLifecycle.failTaskRun(...params);

export async function wakeImageGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: ImageGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await imageGenerationTaskLifecycle.wakeTaskCompletion(params);
}
