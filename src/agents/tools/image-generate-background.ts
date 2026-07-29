/**
 * Image generation background task facade.
 *
 * Binds shared detached media-task lifecycle behavior to image_generate labels and completion messages.
 */
import { IMAGE_GENERATION_TASK_KIND } from "../image-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

/** Detached image generation task handle. */
export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;

/** Shared lifecycle instance configured for image generation. */
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

/** Creates an image generation task ledger run. */
export const createImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.createTaskRun>
) => imageGenerationTaskLifecycle.createTaskRun(...params);

/** Records progress for an image generation task. */
export const recordImageGenerationTaskProgress = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.recordTaskProgress>
) => imageGenerationTaskLifecycle.recordTaskProgress(...params);

/** Completes an image generation task ledger run. */
export const completeImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.completeTaskRun>
) => imageGenerationTaskLifecycle.completeTaskRun(...params);

/** Marks an image generation task ledger run as failed. */
export const failImageGenerationTaskRun = (
  ...params: Parameters<typeof imageGenerationTaskLifecycle.failTaskRun>
) => imageGenerationTaskLifecycle.failTaskRun(...params);
