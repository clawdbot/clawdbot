/**
 * Video generation task status helpers.
 *
 * These wrap the generic media task status helpers with video-specific kind,
 * source, labels, duplicate-guard timing, and prompt-context wording.
 */
import { createMediaGenerationTaskStatusOwner } from "./media-generation-task-status-shared.js";

export const VIDEO_GENERATION_TASK_KIND = "video_generation";

/** Binds video-specific task identity, duplicate guards, and visible status text. */
export const {
  findActiveTaskForSession: findActiveVideoGenerationTaskForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardVideoGenerationTaskForSession,
  buildTaskStatusDetails: buildVideoGenerationTaskStatusDetails,
  buildTaskStatusText: buildVideoGenerationTaskStatusText,
  buildActiveTaskPromptContextForSession: buildActiveVideoGenerationTaskPromptContextForSession,
} = createMediaGenerationTaskStatusOwner({
  taskKind: VIDEO_GENERATION_TASK_KIND,
  toolName: "video_generate",
  nounLabel: "Video generation",
  completionLabel: "video",
  promptCompletionLabel: "videos",
});
