/**
 * Image generation task status helpers.
 *
 * These wrap the shared media task status helpers with image-specific task kind,
 * source id, duplicate-guard timing, and prompt/status wording.
 */
import { createMediaGenerationTaskStatusOwner } from "./media-generation-task-status-shared.js";

export const IMAGE_GENERATION_TASK_KIND = "image_generation";

/** Image generation keeps multi-task status and prompt-specific duplicate lookup. */
export const {
  findActiveTaskForSession: findActiveImageGenerationTaskForSession,
  listActiveTasksForSession: listActiveImageGenerationTasksForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardImageGenerationTaskForSession,
  buildTaskStatusDetails: buildImageGenerationTaskStatusDetails,
  buildTaskStatusListDetails: buildImageGenerationTaskStatusListDetails,
  buildTaskStatusText: buildImageGenerationTaskStatusText,
  buildTaskStatusListText: buildImageGenerationTaskStatusListText,
  buildActiveTaskPromptContextForSession: buildActiveImageGenerationTaskPromptContextForSession,
} = createMediaGenerationTaskStatusOwner({
  taskKind: IMAGE_GENERATION_TASK_KIND,
  toolName: "image_generate",
  nounLabel: "Image generation",
  completionLabel: "image",
  promptCompletionLabel: "images",
});
