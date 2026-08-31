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

/**
 * Music-generation task status adapters. The module specializes the shared
 * media-generation task helpers with music task ids, duplicate guards, and
 * user-facing status text.
 */

/** Task kind used for music generation task registry records. */
export const MUSIC_GENERATION_TASK_KIND = "music_generation";

/** Binds music-specific task identity, duplicate guards, and visible status text. */
export const {
  findActiveTaskForSession: findActiveMusicGenerationTaskForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardMusicGenerationTaskForSession,
  buildTaskStatusDetails: buildMusicGenerationTaskStatusDetails,
  buildTaskStatusText: buildMusicGenerationTaskStatusText,
  buildActiveTaskPromptContextForSession: buildActiveMusicGenerationTaskPromptContextForSession,
} = createMediaGenerationTaskStatusOwner({
  taskKind: MUSIC_GENERATION_TASK_KIND,
  toolName: "music_generate",
  nounLabel: "Music generation",
  completionLabel: "music",
  promptCompletionLabel: "music tracks",
});

/**
 * Video generation task status helpers.
 *
 * These wrap the generic media task status helpers with video-specific kind,
 * source, labels, duplicate-guard timing, and prompt-context wording.
 */

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
